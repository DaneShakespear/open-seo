import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { organization, user } from "@/db/schema";
import { MCP_ROUTE } from "@/server/mcp/context";
import type { resolveCloudflareAccessContext as ResolveCloudflareAccessContext } from "./cloudflareAccess";
import type { resolveUserContextFromHeaders as ResolveUserContextFromHeaders } from "./resolve";

// The modules under test bind `db` at import time. The in-memory client only
// exists after beforeAll, so they load once the mock can point at it.
const mockEnv = vi.hoisted(() => ({
  AUTH_MODE: "cloudflare_access",
  DATABASE_PROVIDER: "d1",
  TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  POLICY_AUD: "policy-aud",
  ACCESS_SERVICE_TOKEN_ALLOWLIST: "",
  ACCESS_SERVICE_TOKEN_USER_EMAIL: "",
}));

const jwtVerify = vi.hoisted(() => vi.fn());

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createRemoteJWKSet: () => vi.fn(),
    jwtVerify,
  };
});

const TOKEN = "signed-access-token";
const TEAM_DOMAIN = "https://team.cloudflareaccess.com";
const POLICY_AUD = "policy-aud";
const ALLOWED_CLIENT_ID = "allowed-client.access";
const UNKNOWN_CLIENT_ID = "unknown-client.access";
const OWNER_EMAIL = "owner@example.com";

let client: Client;
let resolveCloudflareAccessContext: typeof ResolveCloudflareAccessContext;
let resolveUserContextFromHeaders: typeof ResolveUserContextFromHeaders;

function accessHeaders() {
  return new Headers({ "cf-access-jwt-assertion": TOKEN });
}

function expectTokenVerified() {
  expect(jwtVerify).toHaveBeenCalledWith(TOKEN, expect.any(Function), {
    issuer: TEAM_DOMAIN,
    audience: POLICY_AUD,
  });
}

async function userCount() {
  const result = await client.execute("SELECT COUNT(*) AS count FROM user");
  return Number(result.rows[0]?.count ?? 0);
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client, { schema: { user, organization } });
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER DEFAULT 0 NOT NULL,
      image TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      analytics_opted_out INTEGER
    );
    CREATE TABLE organization (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      logo TEXT,
      created_at INTEGER NOT NULL,
      metadata TEXT
    );
  `);

  ({ resolveCloudflareAccessContext } = await import("./cloudflareAccess"));
  ({ resolveUserContextFromHeaders } = await import("./resolve"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  mockEnv.AUTH_MODE = "cloudflare_access";
  mockEnv.TEAM_DOMAIN = TEAM_DOMAIN;
  mockEnv.POLICY_AUD = POLICY_AUD;
  mockEnv.ACCESS_SERVICE_TOKEN_ALLOWLIST = "";
  mockEnv.ACCESS_SERVICE_TOKEN_USER_EMAIL = "";
  jwtVerify.mockReset();
  jwtVerify.mockResolvedValue({
    payload: { sub: "user-1", email: "person@example.com" },
  });
  await client.executeMultiple(`
    DELETE FROM organization;
    DELETE FROM user;
  `);
});

describe("resolveCloudflareAccessContext", () => {
  it("resolves a human access JWT as that user", async () => {
    mockEnv.ACCESS_SERVICE_TOKEN_ALLOWLIST = ALLOWED_CLIENT_ID;
    mockEnv.ACCESS_SERVICE_TOKEN_USER_EMAIL = OWNER_EMAIL;
    jwtVerify.mockResolvedValue({
      payload: {
        sub: "user-1",
        email: "person@example.com",
        common_name: ALLOWED_CLIENT_ID,
      },
    });

    const context = await resolveCloudflareAccessContext(accessHeaders(), {
      pathname: MCP_ROUTE,
    });

    expectTokenVerified();
    expect(context).toMatchObject({
      userId: "user-1",
      userEmail: "person@example.com",
      emailVerified: true,
      organizationId: "shared-workspace",
    });
  });

  it("resolves an allowlisted service token on /mcp as the mapped user", async () => {
    mockEnv.ACCESS_SERVICE_TOKEN_ALLOWLIST = `other-client.access, ${ALLOWED_CLIENT_ID}`;
    mockEnv.ACCESS_SERVICE_TOKEN_USER_EMAIL = OWNER_EMAIL;
    await client.execute({
      sql: "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)",
      args: ["owner-1", "Owner", OWNER_EMAIL],
    });
    jwtVerify.mockResolvedValue({
      payload: { sub: "", common_name: ALLOWED_CLIENT_ID },
    });

    const context = await resolveCloudflareAccessContext(accessHeaders(), {
      pathname: MCP_ROUTE,
    });

    expectTokenVerified();
    expect(context).toMatchObject({
      userId: "owner-1",
      userEmail: OWNER_EMAIL,
      emailVerified: true,
      organizationId: "shared-workspace",
    });
    expect(await userCount()).toBe(1);
  });

  it("rejects an allowlisted service token on a non-/mcp route", async () => {
    mockEnv.ACCESS_SERVICE_TOKEN_ALLOWLIST = ALLOWED_CLIENT_ID;
    mockEnv.ACCESS_SERVICE_TOKEN_USER_EMAIL = OWNER_EMAIL;
    jwtVerify.mockResolvedValue({
      payload: { sub: "", common_name: ALLOWED_CLIENT_ID },
    });

    await expect(
      resolveUserContextFromHeaders(accessHeaders()),
    ).rejects.toMatchObject({ name: "AppError", code: "FORBIDDEN" });
    expectTokenVerified();
    expect(await userCount()).toBe(0);
  });

  it("does not create a user when the mapped email has no account", async () => {
    mockEnv.ACCESS_SERVICE_TOKEN_ALLOWLIST = ALLOWED_CLIENT_ID;
    mockEnv.ACCESS_SERVICE_TOKEN_USER_EMAIL = OWNER_EMAIL;
    jwtVerify.mockResolvedValue({
      payload: { sub: "", common_name: ALLOWED_CLIENT_ID },
    });

    await expect(
      resolveCloudflareAccessContext(accessHeaders(), { pathname: MCP_ROUTE }),
    ).resolves.toBeNull();
    expect(await userCount()).toBe(0);
  });

  it("rejects an unknown service token without throwing", async () => {
    mockEnv.ACCESS_SERVICE_TOKEN_ALLOWLIST = ALLOWED_CLIENT_ID;
    mockEnv.ACCESS_SERVICE_TOKEN_USER_EMAIL = OWNER_EMAIL;
    jwtVerify.mockResolvedValue({
      payload: { sub: "", common_name: UNKNOWN_CLIENT_ID },
    });

    await expect(
      resolveCloudflareAccessContext(accessHeaders(), { pathname: MCP_ROUTE }),
    ).resolves.toBeNull();
    expectTokenVerified();
    expect(await userCount()).toBe(0);
  });
});
