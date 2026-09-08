import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { WhatsAppService } from '../../services/whatsapp.service';
import { logger } from '../../config/logger';

const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_COMPLAINTS_URL || 'https://script.google.com/macros/s/AKfycbwEIj1gZusldwBYtIx4WeiLE9vBpZgpYiDqUVLvytP4AgBdsfSIuvqHtUvkGOidqx3iCQ/exec';

// Set of known ticket IDs to prevent duplicate alerts
const knownTickets = new Set<string>();
let isInitialized = false;

export interface ComplaintItem {
  id: string;
  ticketId: string;
  channel: 'waau' | 'direct-sms';
  complainantName: string;
  complainantPhone: string;
  complainantEmail?: string;
  company?: string;
  subject: string;
  description: string;
  category: 'Billing' | 'Technical' | 'Service Quality' | 'Account' | 'Other';
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'in-progress' | 'resolved' | 'closed';
  imageUrl?: string;
  assignedTo?: string;
  createdAt: string;
  updatedAt: string;
  resolutionNotes?: string;
}

export class ComplaintsController {
  /**
   * Internal helper to fetch and sync complaints from Google Sheet
   */
  static async fetchAndSyncComplaints(): Promise<ComplaintItem[]> {
    const response = await fetch(GOOGLE_SHEET_URL, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(`Google Sheet Apps Script returned HTTP status ${response.status}`);
    }

    const data = await response.json();
    const newComplaints: ComplaintItem[] = [];

    const waauComplaints: ComplaintItem[] = (data.waau || []).map((w: any, idx: number) => {
      const imageUrl = w.imageUrl && typeof w.imageUrl === 'string' && w.imageUrl.startsWith('http') ? w.imageUrl : undefined;
      const item: ComplaintItem = {
        id: `waau-gs-${w.ticketId || idx}`,
        ticketId: w.ticketId || `WAAU-${idx + 100}`,
        channel: 'waau',
        complainantName: w.user || 'Unknown User',
        complainantPhone: String(w.phone || 'N/A'),
        company: w.company || '',
        subject: w.details ? (w.details.length > 40 ? w.details.substring(0, 40) + '...' : w.details) : 'WAAU Complaint',
        description: w.details || 'No complaint details.',
        category: (w.section === 'Waau' ? 'Technical' : (w.section as any)) || 'Technical',
        priority: 'high',
        status: 'open',
        imageUrl,
        createdAt: w.dateTime || new Date().toISOString(),
        updatedAt: w.dateTime || new Date().toISOString(),
      };

      if (!knownTickets.has(item.ticketId)) {
        if (isInitialized) {
          newComplaints.push(item);
        }
        knownTickets.add(item.ticketId);
      }

      return item;
    });

    const smsComplaints: ComplaintItem[] = (data.sms || []).map((s: any, idx: number) => {
      const imageUrl = s.imageUrl && typeof s.imageUrl === 'string' && s.imageUrl.startsWith('http') ? s.imageUrl : undefined;
      const item: ComplaintItem = {
        id: `sms-gs-${s.ticketId || idx}`,
        ticketId: s.ticketId || `SMS-${idx + 100}`,
        channel: 'direct-sms',
        complainantName: s.clientName || 'Unknown Client',
        complainantPhone: String(s.phone || 'N/A'),
        subject: s.complaint ? (s.complaint.length > 40 ? s.complaint.substring(0, 40) + '...' : s.complaint) : 'Direct SMS Complaint',
        description: s.complaint || 'No complaint details.',
        category: 'Service Quality',
        priority: 'medium',
        status: 'open',
        imageUrl,
        createdAt: s.createdAt || new Date().toISOString(),
        updatedAt: s.createdAt || new Date().toISOString(),
      };

      if (!knownTickets.has(item.ticketId)) {
        if (isInitialized) {
          newComplaints.push(item);
        }
        knownTickets.add(item.ticketId);
      }

      return item;
    });

    // Mark initial baseline complete
    if (!isInitialized) {
      isInitialized = true;
      logger.info(`[ComplaintsController] Initialized baseline with ${knownTickets.size} existing complaint tickets.`);
    }

    // Send WhatsApp template alert for any newly detected complaint
    if (newComplaints.length > 0) {
      logger.info(`[ComplaintsController] Detected ${newComplaints.length} NEW complaint(s). Dispatching WhatsApp notifications...`);
      for (const comp of newComplaints) {
        void WhatsAppService.sendComplaintAlert({
          ticketId: comp.ticketId,
          channel: comp.channel,
          complainantName: comp.complainantName,
          complainantPhone: comp.complainantPhone,
          company: comp.company,
          details: comp.description,
          category: comp.category,
          imageUrl: comp.imageUrl,
          createdAt: comp.createdAt
        });
      }
    }

    return [...waauComplaints, ...smsComplaints];
  }

  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const complaints = await ComplaintsController.fetchAndSyncComplaints();
      return res.json({
        success: true,
        complaints,
        count: complaints.length,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Endpoint to trigger a WhatsApp alert manually for any complaint or test
   */
  static async sendWhatsAppAlert(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { ticketId, channel, complainantName, complainantPhone, company, details, category, imageUrl, recipientPhone } = req.body;

      const success = await WhatsAppService.sendComplaintAlert(
        {
          ticketId: ticketId || 'WAAU-MANUAL-001',
          channel: channel || 'waau',
          complainantName: complainantName || 'Client',
          complainantPhone: complainantPhone || 'N/A',
          company: company || '',
          details: details || 'New complaint submitted via Work OS dashboard.',
          category: category || 'Technical',
          imageUrl: imageUrl || undefined,
          createdAt: new Date().toISOString(),
        },
        recipientPhone
      );

      return res.json({
        success,
        message: success ? 'WhatsApp alert dispatched successfully.' : 'Failed to send WhatsApp alert. Check backend environment variables.'
      });
    } catch (error) {
      next(error);
    }
  }
}

// Start continuous background polling (every 30 seconds) to check Google Sheet for new complaints automatically!
let isPollingStarted = false;
export function startGoogleSheetPolling() {
  if (isPollingStarted) return;
  isPollingStarted = true;
  logger.info('[ComplaintsController] 🚀 Started Google Sheet auto-sync background polling (every 30s)');

  // Initial sync immediately
  void ComplaintsController.fetchAndSyncComplaints().catch(err => {
    logger.warn('[ComplaintsController] Initial Google Sheet sync failed:', err?.message || err);
  });

  // Poll every 30 seconds
  setInterval(async () => {
    try {
      await ComplaintsController.fetchAndSyncComplaints();
    } catch (err: any) {
      logger.warn('[ComplaintsController] Background polling sync failed:', err?.message || err);
    }
  }, 30000);
}
