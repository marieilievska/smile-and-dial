// One-off seeding of the first admin and the Playwright E2E test account.
//
//   node --env-file=.env.local scripts/seed.mjs
//
// The first admin is seeded only when SEED_ADMIN_PASSWORD is provided:
//   SEED_ADMIN_PASSWORD=... node --env-file=.env.local scripts/seed.mjs
//
// Re-running is safe: users that already exist are skipped.

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const users = [
  {
    label: "first super admin",
    email: "marie@referrizer.com",
    password: process.env.SEED_ADMIN_PASSWORD,
    fullName: "Marija Ilievska",
    role: "super_admin",
  },
  {
    label: "E2E test user",
    email: process.env.E2E_TEST_EMAIL,
    password: process.env.E2E_TEST_PASSWORD,
    fullName: "E2E Test User",
    role: "super_admin",
  },
  {
    label: "E2E member user",
    email: process.env.E2E_MEMBER_EMAIL,
    password: process.env.E2E_MEMBER_PASSWORD,
    fullName: "E2E Member User",
    role: "member",
  },
];

let hadError = false;

for (const user of users) {
  if (!user.email || !user.password) {
    console.log(`- Skipped ${user.label}: no email/password provided.`);
    continue;
  }

  const { data, error } = await admin.auth.admin.createUser({
    email: user.email,
    password: user.password,
    email_confirm: true,
    user_metadata: { full_name: user.fullName },
  });

  if (!error) {
    // handle_new_user() always creates the profile as 'member' and never reads
    // a role from user_metadata (20260906010000 — a signup must not be able to
    // pick its own role), so the seeded role is applied here instead.
    if (data?.user?.id && user.role !== "member") {
      const { error: roleError } = await admin
        .from("profiles")
        .update({ role: user.role })
        .eq("id", data.user.id);
      if (roleError) {
        console.error(
          `x Failed to set role for ${user.label}: ${roleError.message}`,
        );
        hadError = true;
      }
    }
    console.log(`+ Created ${user.label}: ${user.email} (${user.role}).`);
  } else if (/already|exists|registered/i.test(error.message)) {
    console.log(`= ${user.label} already exists: ${user.email}.`);
  } else {
    console.error(`x Failed ${user.label}: ${error.message}`);
    hadError = true;
  }
}

process.exit(hadError ? 1 : 0);
