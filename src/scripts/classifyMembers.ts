import { AppPrisma, createPrismaClient, disconnectPrisma } from "../config/prisma";
import { categoryFromMemberCode } from "../services/memberClassification.service";

export async function classifyExistingMembers(prisma: AppPrisma) {
  const members = await prisma.member.findMany({
    select: { id: true, memberCode: true, customFields: true },
  });
  const counts = { Trustee: 0, "Life Member": 0, Ordinary: 0 };

  for (const member of members) counts[categoryFromMemberCode(member.memberCode)] += 1;

  await prisma.$executeRawUnsafe(`
    UPDATE "Member"
    SET "customFields" = jsonb_set(
      jsonb_set(COALESCE("customFields", '{}'::jsonb), '{category}', to_jsonb(
        CASE
          WHEN UPPER(TRIM(COALESCE("memberCode", ''))) LIKE 'T%' THEN 'Trustee'::text
          WHEN UPPER(TRIM(COALESCE("memberCode", ''))) LIKE 'L%' THEN 'Life Member'::text
          ELSE 'Ordinary'::text
        END
      ), true),
      '{designation}', to_jsonb(
        CASE
          WHEN UPPER(TRIM(COALESCE("memberCode", ''))) LIKE 'T%' THEN 'Trustee'::text
          WHEN UPPER(TRIM(COALESCE("memberCode", ''))) LIKE 'L%' THEN 'Life Member'::text
          ELSE 'Ordinary'::text
        END
      ), true
    )
  `);
  return { total: members.length, counts };
}

if (require.main === module) {
  const prisma = createPrismaClient();
  classifyExistingMembers(prisma)
    .then((result) => console.log(JSON.stringify(result)))
    .finally(() => disconnectPrisma());
}
