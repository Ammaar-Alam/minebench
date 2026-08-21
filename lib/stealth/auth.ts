import type { OrganizationRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type LabIdentity = {
  user: {
    id: string;
    email: string;
    displayName: string | null;
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
  const email = authUser?.email?.trim().toLowerCase();
  if (error || !authUser || !email) return null;

  const user = await prisma.user.upsert({
    where: { id: authUser.id },
    create: {
      id: authUser.id,
      email,
      displayName:
        typeof authUser.user_metadata?.name === "string"
          ? authUser.user_metadata.name.trim().slice(0, 120) || null
          : null,
      lastSeenAt: new Date(),
    },
    update: {
      email,
      lastSeenAt: new Date(),
    },
    select: {
      id: true,
      email: true,
      displayName: true,
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

  if (user.memberships.length > 0) {
    await prisma.organizationInvitation.updateMany({
      where: {
        authUserId: user.id,
        acceptedAt: null,
        revokedAt: null,
        organizationId: { in: user.memberships.map(({ organization }) => organization.id) },
      },
      data: {
        acceptedById: user.id,
        acceptedAt: new Date(),
      },
    });
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
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
