import { autumnHandler } from "autumn-js/next";
import { getSession } from "@/lib/auth-server";
import { getOrgsSafe } from "@/lib/api";

export const { GET, POST, DELETE } = autumnHandler({
  secretKey: process.env.AUTUMN_SECRET_KEY,
  identify: async () => {
    const session = await getSession();
    if (!session?.user?.id) return { customerId: null };

    // Use orgId as customerId (billing is per-org)
    const orgs = await getOrgsSafe();
    const org = orgs[0];

    return {
      customerId: org?.id ?? session.user.id,
      customerData: {
        name: org?.name ?? session.user.name,
        email: session.user.email,
      },
    };
  },
});
