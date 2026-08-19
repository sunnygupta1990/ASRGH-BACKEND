export const MEMBER_CATEGORIES = ["Trustee", "Life Member", "Ordinary"] as const;
export type MemberCategory = (typeof MEMBER_CATEGORIES)[number];

export function categoryFromMemberCode(memberCode: string | null | undefined): MemberCategory {
  const code = String(memberCode ?? "").trim().toUpperCase();
  if (code.startsWith("T")) return "Trustee";
  if (code.startsWith("L")) return "Life Member";
  return "Ordinary";
}

export function classifiedCustomFields(
  memberCode: string | null | undefined,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const category = categoryFromMemberCode(memberCode);
  return { ...existing, category, designation: category };
}

const numericCodeCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function compareMemberCodes(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const rank = (code: string | null | undefined) => {
    const category = categoryFromMemberCode(code);
    return category === "Trustee" ? 0 : category === "Life Member" ? 1 : 2;
  };
  return rank(left) - rank(right) || numericCodeCollator.compare(String(left ?? ""), String(right ?? ""));
}
