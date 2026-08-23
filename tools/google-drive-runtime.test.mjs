import assert from "node:assert/strict";
import test from "node:test";
import { loadGoogleApisForAuthorization } from "../scripts/google-drive-authorize.mjs";
import { readDriveOwner } from "../scripts/google-drive-oauth.mjs";
import { loadGoogleApisForProvisioning } from "../scripts/google-drive-provision.mjs";

test("both production CLI loaders resolve the real API-owned googleapis package", async () => {
  const authorizationModule = await loadGoogleApisForAuthorization();
  const provisioningModule = await loadGoogleApisForProvisioning();

  assert.equal(typeof authorizationModule.google.auth.OAuth2, "function");
  assert.equal(typeof authorizationModule.google.drive, "function");
  assert.equal(typeof provisioningModule.google.auth.OAuth2, "function");
  assert.equal(typeof provisioningModule.google.drive, "function");
});

test("the shared owner readback disables googleapis retries", async () => {
  const calls = [];
  const owner = await readDriveOwner({
    about: {
      get: async (input, options) => {
        calls.push({ input, options });
        return { data: { user: { emailAddress: "owner@example.com", displayName: "Owner" } } };
      }
    }
  });

  assert.deepEqual(owner, { emailAddress: "owner@example.com", displayName: "Owner" });
  assert.deepEqual(calls, [
    {
      input: { fields: "user(emailAddress,displayName)" },
      options: { retry: false }
    }
  ]);
});
