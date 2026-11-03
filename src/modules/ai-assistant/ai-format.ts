/** +91 98765 43210 for Indian numbers, +<digits> otherwise */
export function formatLeadPhone(phone: string) {
  if (/^91\d{10}$/.test(phone)) return `+91 ${phone.slice(2, 7)} ${phone.slice(7)}`;
  return `+${phone}`;
}
