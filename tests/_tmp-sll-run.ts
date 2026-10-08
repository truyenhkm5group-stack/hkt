import "./setup-env";
import { ensureMigrated } from "@/db/migrate";
import { testShellLoginLanding } from "./shell-login-landing.test";
import { testLoginThrottle } from "./login-throttle.test";
import { testSaasShell } from "./saas-shell.test";
import { testQuickStart } from "./quick-start.test";
import { testOnboarding } from "./onboarding.test";
import { testAccessControl } from "./access-control.test";
import { testTenantAttack } from "./tenant-attack.test";
import { testPlatformRbac } from "./platform-rbac.test";
import { testUserInvites } from "./user-invites.test";

(async () => {
  await ensureMigrated();
  const only = process.env.ONLY;
  if (!only || only === "landing") await testShellLoginLanding();
  if (!only) {
    await testLoginThrottle();
    await testSaasShell();
    await testQuickStart();
    await testOnboarding();
    testAccessControl();
    await testTenantAttack();
    await testPlatformRbac();
    await testUserInvites();
  }
  console.log("TMP RUN OK");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
