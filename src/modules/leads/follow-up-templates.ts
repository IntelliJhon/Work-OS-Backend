/**
 * Automatic WhatsApp follow-ups to a lead (the client) about the proposal they have not answered. At each follow-up
 * time of a lead in Proposal sent / Follow up the next step goes out; after the last one Work OS stops, and a new
 * proposal version starts again from the first. Each is a WAAU/Meta template (English, Utility) with this body:
 * {{1}} the lead's name, {{2}} the workspace's company name, {{3}} what they are interested in. Meta refuses a
 * template that starts or ends with a variable, so every body ends with plain text.
 */
export interface FollowUpStep { template: string; label: string; text: string }

export const CLIENT_FOLLOW_UPS: FollowUpStep[] = [
  {
    template: 'lead_follow_up_review',
    label: 'Proposal review check-in',
    text: 'Hi {{1}}, this is {{2}}. Just checking whether you had a chance to go through our proposal for {{3}}. We are happy to answer any questions.',
  },
  {
    template: 'lead_follow_up_call',
    label: 'Offer to explain on a call',
    text: 'Hi {{1}}, this is {{2}}. If it helps, we would be glad to walk you through our proposal for {{3}} on a quick call. Please reply with a time that suits you.',
  },
  {
    template: 'lead_follow_up_final',
    label: 'Final follow-up',
    text: 'Hi {{1}}, this is {{2}}. We have not heard back about our proposal for {{3}}, so we will pause our follow-ups for now. Whenever you are ready, just reply here and we will pick it up.',
  },
];
