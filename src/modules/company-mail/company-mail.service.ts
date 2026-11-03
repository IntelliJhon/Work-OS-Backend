import { and, desc, eq, inArray } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { ImapFlow } from 'imapflow';
import { db } from '../../db';
import { emails, tenantMailAccounts, type EmailAttachment } from '../../db/schema/company_mail';
import { leadActivity, leads } from '../../db/schema/leads';
import { uploads } from '../../db/schema/uploads';
import { users } from '../../db/schema/users';
import { withTenant } from '../../middleware/tenant.middleware';
import { decryptSecret, encryptSecret, isEncryptionConfigured } from '../../lib/crypto';
import { UploadService } from '../uploads/upload.service';
import { logger } from '../../config/logger';

/**
 * The workspace's company email (e.g. info@intellijohn.com). Admins set the mailbox up; anyone who can work on leads
 * sends from it. Each email goes out over SMTP, a copy is saved to the mailbox's Sent folder over IMAP (so it shows in
 * the mail app like any other sent mail), and it is logged with who sent it, and on the lead's history.
 */

export class MailError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface MailSettingsInput {
  fromEmail: string;
  fromName?: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost?: string | null;
  imapPort: number;
  username: string;
  // Omitted = keep the saved one
  password?: string;
  signature?: string | null;
}

export interface OutgoingEmail {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  leadId?: string | null;
  // Files already in Work OS (e.g. a proposal) and new files picked for this email
  uploadIds?: string[];
  files?: { name: string; content: Buffer; contentType: string }[];
  via?: 'manual' | 'ai';
}

type Account = typeof tenantMailAccounts.$inferSelect;
const TIMEOUT_MS = 20_000;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const asHtml = (text: string) => `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;

function transport(a: Account) {
  return nodemailer.createTransport({
    host: a.smtpHost,
    port: a.smtpPort,
    secure: a.smtpSecure,
    auth: { user: a.username, pass: decryptSecret(a.passwordEncrypted) },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 2,
  });
}

function imap(a: Account) {
  return new ImapFlow({
    host: a.imapHost!,
    port: a.imapPort,
    secure: true,
    auth: { user: a.username, pass: decryptSecret(a.passwordEncrypted) },
    logger: false,
    connectionTimeout: TIMEOUT_MS,
  });
}

/** The mailbox's Sent folder, by its special-use flag (names differ: "Sent", "Sent Items", "INBOX.Sent"…) */
async function sentFolder(client: ImapFlow) {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === '\\Sent')?.path
    ?? boxes.find((b) => /^(inbox[./])?sent( (items|messages|mail))?$/i.test(b.path))?.path
    ?? null;
}

const friendly = (err: any) => {
  const code = err?.code ?? err?.responseCode;
  if (code === 'EAUTH' || code === 535 || err?.authenticationFailed) return 'The mailbox rejected the username or password';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ECONNREFUSED') {
    return 'Could not reach the mail server (the port may be blocked by the hosting provider)';
  }
  return err?.message ? String(err.message).slice(0, 300) : 'Unknown error';
};

export class CompanyMailService {
  private static async account(tenantId: string) {
    const [a] = await db.select().from(tenantMailAccounts).where(eq(tenantMailAccounts.tenantId, tenantId)).limit(1);
    return a ?? null;
  }

  /** For everyone: whether email is set up and which address it sends from */
  static async status(tenantId: string) {
    const a = await this.account(tenantId);
    return { configured: !!a, fromEmail: a?.fromEmail ?? null, fromName: a?.fromName ?? null };
  }

  /** For Admins: the settings without the password */
  static async settings(tenantId: string) {
    const a = await this.account(tenantId);
    if (!a) return null;
    const { passwordEncrypted: _hidden, ...rest } = a;
    return { ...rest, hasPassword: true };
  }

  static async save(tenantId: string, userId: string, input: MailSettingsInput) {
    if (!isEncryptionConfigured()) throw new MailError(503, 'encryption', 'The server has no SECRETS_ENCRYPTION_KEY, so the password cannot be stored safely');
    const before = await this.account(tenantId);
    if (!before && !input.password) throw new MailError(400, 'password', 'Enter the mailbox password');
    const values = {
      fromEmail: input.fromEmail.trim().toLowerCase(),
      fromName: input.fromName?.trim() || null,
      smtpHost: input.smtpHost.trim(),
      smtpPort: input.smtpPort,
      smtpSecure: input.smtpSecure,
      imapHost: input.imapHost?.trim() || null,
      imapPort: input.imapPort,
      username: input.username.trim(),
      ...(input.password ? { passwordEncrypted: encryptSecret(input.password) } : {}),
      signature: input.signature?.trim() || null,
      updatedBy: userId,
      updatedAt: new Date(),
    };
    if (before) await db.update(tenantMailAccounts).set(values).where(eq(tenantMailAccounts.tenantId, tenantId));
    else await db.insert(tenantMailAccounts).values({ tenantId, ...values, passwordEncrypted: values.passwordEncrypted! });
    return this.settings(tenantId);
  }

  static async remove(tenantId: string) {
    await db.delete(tenantMailAccounts).where(eq(tenantMailAccounts.tenantId, tenantId));
    return { removed: true };
  }

  /** Logs in to SMTP (sending) and IMAP (Sent folder) without sending anything */
  static async test(tenantId: string) {
    const a = await this.account(tenantId);
    if (!a) throw new MailError(400, 'not_configured', 'Save the email settings first');
    const result = { smtp: { ok: false, error: null as string | null }, imap: { ok: false, error: null as string | null, sentFolder: null as string | null } };
    try {
      await transport(a).verify();
      result.smtp.ok = true;
    } catch (err) {
      result.smtp.error = friendly(err);
    }
    if (a.imapHost) {
      const client = imap(a);
      try {
        await client.connect();
        result.imap.sentFolder = await sentFolder(client);
        result.imap.ok = true;
        if (!result.imap.sentFolder) result.imap.error = 'Logged in, but no Sent folder was found';
      } catch (err) {
        result.imap.error = friendly(err);
      } finally {
        await client.logout().catch(() => undefined);
      }
    } else {
      result.imap.error = 'No IMAP server set: sent emails will not be copied to the Sent folder';
    }
    const ok = result.smtp.ok;
    await db.update(tenantMailAccounts).set({ lastTestAt: new Date(), lastTestOk: ok, lastTestError: ok ? null : result.smtp.error })
      .where(eq(tenantMailAccounts.tenantId, tenantId));
    return result;
  }

  /** Sends an email from the company address and logs it (and on the lead, when it is for one) */
  static async send(tenantId: string, userId: string, mail: OutgoingEmail) {
    const a = await this.account(tenantId);
    if (!a) throw new MailError(400, 'not_configured', 'Company email is not set up yet. An Admin can add it in Settings → Company email.');
    const to = [...new Set(mail.to.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    const cc = [...new Set((mail.cc ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
    if (!to.length) throw new MailError(400, 'to', 'Add at least one recipient');
    const subject = mail.subject.trim().slice(0, 300);
    if (!subject) throw new MailError(400, 'subject', 'Add a subject');

    let lead: { id: string; name: string } | null = null;
    if (mail.leadId) {
      const [l] = await db.select({ id: leads.id, name: leads.name }).from(leads).where(and(eq(leads.id, mail.leadId), eq(leads.tenantId, tenantId))).limit(1);
      if (!l) throw new MailError(404, 'lead', 'Lead not found');
      lead = l;
    }

    // Attachments: Work OS files are downloaded from storage
    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    const logged: EmailAttachment[] = [];
    if (mail.uploadIds?.length) {
      const rows = await withTenant<(typeof uploads.$inferSelect)[]>(tenantId, (tx) =>
        tx.select().from(uploads).where(and(eq(uploads.tenantId, tenantId), inArray(uploads.id, mail.uploadIds!))));
      for (const u of rows) {
        const res = await fetch(await UploadService.getSignedDownloadUrl(tenantId, u.id), { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new MailError(502, 'attachment', `Could not load "${u.originalName}" to attach it`);
        attachments.push({ filename: u.originalName, content: Buffer.from(await res.arrayBuffer()), contentType: u.mimeType });
        logged.push({ name: u.originalName, uploadId: u.id });
      }
    }
    for (const f of mail.files ?? []) {
      attachments.push({ filename: f.name, content: f.content, contentType: f.contentType });
      logged.push({ name: f.name });
    }
    if (attachments.reduce((n, x) => n + x.content.length, 0) > MAX_TOTAL_BYTES) throw new MailError(400, 'size', 'Attachments can be at most 20 MB in total');

    const text = a.signature ? `${mail.body.trimEnd()}\n\n${a.signature}` : mail.body.trimEnd();
    const message = {
      from: a.fromName ? { name: a.fromName, address: a.fromEmail } : a.fromEmail,
      to, cc: cc.length ? cc : undefined, subject, text, html: asHtml(text), attachments,
    };
    // Built once: the same bytes are sent and saved to the Sent folder
    const raw = await new MailComposer(message).compile().build();

    let status: 'sent' | 'failed' = 'sent';
    let error: string | null = null;
    let messageId: string | null = null;
    try {
      const info = await transport(a).sendMail({ envelope: { from: a.fromEmail, to: [...to, ...cc] }, raw });
      messageId = info.messageId ?? null;
    } catch (err) {
      status = 'failed';
      error = friendly(err);
      logger.warn({ err, tenantId }, '[CompanyMail] Send failed');
    }

    let savedToSent = false;
    if (status === 'sent' && a.imapHost) {
      const client = imap(a);
      try {
        await client.connect();
        const folder = await sentFolder(client);
        if (folder) savedToSent = !!(await client.append(folder, raw, ['\\Seen']));
      } catch (err) {
        logger.warn({ err, tenantId }, '[CompanyMail] Could not save the copy to the Sent folder');
      } finally {
        await client.logout().catch(() => undefined);
      }
    }

    const [row] = await db.insert(emails).values({
      tenantId, leadId: lead?.id ?? null, sentBy: userId, fromEmail: a.fromEmail, to, cc, subject, body: mail.body,
      attachments: logged, status, error, messageId, savedToSent, via: mail.via ?? 'manual',
    }).returning();
    if (lead) {
      const files = logged.length ? ` with ${logged.map((x) => x.name).join(', ')}` : '';
      await db.insert(leadActivity).values({
        tenantId, leadId: lead.id, actorId: userId, kind: 'email',
        body: status === 'sent' ? `Emailed "${subject}" to ${to.join(', ')}${files}` : `Email "${subject}" could not be sent: ${error}`,
        meta: { emailId: row.id, status, via: mail.via ?? 'manual' },
      });
    }
    if (status === 'failed') throw new MailError(502, 'send_failed', `The email was not sent: ${error}`);
    return { id: row.id, status, savedToSent, to, subject };
  }

  /** Emails sent for a lead, newest first */
  static async forLead(tenantId: string, leadId: string) {
    const rows = await db.select().from(emails).where(and(eq(emails.tenantId, tenantId), eq(emails.leadId, leadId))).orderBy(desc(emails.createdAt)).limit(50);
    const ids = [...new Set(rows.map((r) => r.sentBy).filter((v): v is string => !!v))];
    const people = ids.length ? await withTenant<{ id: string; firstName: string; lastName: string }[]>(tenantId, (tx) =>
      tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, ids))) : [];
    const name = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    return rows.map((r) => ({ ...r, sentByName: r.sentBy ? name.get(r.sentBy) ?? null : null }));
  }
}
