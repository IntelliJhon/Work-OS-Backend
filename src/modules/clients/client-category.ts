/**
 * Client categorization (Onboarding Clients and the Enquiry List): category, subcategory, "Uses software?" and the
 * software's name. Values come from the forms or from an uploaded sheet, so they are cleaned the same way here.
 */

const text = (v: unknown, max: number) => {
  if (v === undefined) return undefined;
  const s = v === null ? '' : String(v).trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
};

/** Yes/No from a form (true/false) or a sheet cell ("Yes", "y", "No", "1", ...); empty = not asked (null) */
export function parseYesNo(v: unknown): boolean | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'using', 'uses'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'none', 'not using'].includes(s)) return false;
  return null;
}

/**
 * The category fields from a request body or a sheet row. Fields that are absent stay undefined (so an update leaves
 * them alone). A software name means the client uses software; "No" clears the name.
 */
export function categoryFields(src: Record<string, unknown>) {
  const category = text(src.category, 80);
  const subcategory = text(src.subcategory, 80);
  let usesSoftware = parseYesNo(src.usesSoftware);
  let softwareName = text(src.softwareName, 120);
  if (softwareName && usesSoftware == null) usesSoftware = true;
  if (usesSoftware === false) softwareName = null;
  const out: { category?: string | null; subcategory?: string | null; usesSoftware?: boolean | null; softwareName?: string | null } = {};
  if (category !== undefined) out.category = category;
  if (subcategory !== undefined) out.subcategory = subcategory;
  if (usesSoftware !== undefined) out.usesSoftware = usesSoftware;
  if (softwareName !== undefined) out.softwareName = softwareName;
  return out;
}
