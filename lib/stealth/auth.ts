import type { OrganizationRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncAuthUser } from "@/lib/auth/account";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { acceptExactEmailInvitations } from "@/lib/stealth/service";

export type LabIdentity = {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    isMineBenchAdmin: boolean;
  };
  memberships: Array<{
    role: OrganizationRole;
    organization: {
      id: string;
      slug: string;
      name: string;
    };
  }>;
};

export async function getLabIdentity(): Promise<LabIdentity | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user: authUser },
    error,
  } = await supabase.auth.getUser();
  if (error || !authUser) return null;
  const savedUser = await syncAuthUser(authUser);
  if (!savedUser) return null;

  await acceptExactEmailInvitations(savedUser);

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: savedUser.id },
    select: {
      id: true,
      email: true,
      displayName: true,
      isMineBenchAdmin: true,
      memberships: {
        orderBy: { organization: { name: "asc" } },
        select: {
          role: true,
          organization: {
            select: { id: true, slug: true, name: true },
          },
        },
      },
    },
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isMineBenchAdmin: user.isMineBenchAdmin,
    },
    memberships: user.memberships,
  };
}

export async function getLabOrganizationContext(organizationSlug: string) {
  const identity = await getLabIdentity();
  if (!identity) return null;
  const membership = identity.memberships.find(
    ({ organization }) => organization.slug === organizationSlug,
  );
  return membership ? { ...identity, membership } : null;
}
