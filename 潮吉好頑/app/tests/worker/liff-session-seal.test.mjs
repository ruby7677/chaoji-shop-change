// LIFF 持久登入的 refresh token 加解密（src/auth-session.ts）。
// Supabase 的 refresh token 可能只有 12 字元：曾因最低長度 16 的限制被判為無效、保存的 session 被刪除，
// 導致 LINE 內每次開啟都重新 OAuth（LINE 原生「登入中…」黑幕）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSourceModule } from "./harness.mjs";

const { sealRefreshToken, openRefreshToken } = await loadSourceModule("auth-session.ts");
const secret = "x".repeat(40);

test("12 字元的 refresh token 加密後可以還原", async () => {
  const sealed = await sealRefreshToken(secret, "abcdefghijkl");
  assert.equal(await openRefreshToken(secret, sealed), "abcdefghijkl");
});

test("較長的 refresh token 同樣可以還原", async () => {
  const token = "Ww2lA4YdeoEqfCbH0ah3zA";
  assert.equal(await openRefreshToken(secret, await sealRefreshToken(secret, token)), token);
});

test("金鑰不同時無法還原", async () => {
  const sealed = await sealRefreshToken(secret, "abcdefghijkl");
  assert.equal(await openRefreshToken("y".repeat(40), sealed), null);
});

test("被竄改的密文無法還原", async () => {
  const sealed = await sealRefreshToken(secret, "abcdefghijkl");
  const tampered = sealed.slice(0, -2) + (sealed.endsWith("AA") ? "BB" : "AA");
  assert.equal(await openRefreshToken(secret, tampered), null);
});

test("格式或版本不符時無法還原", async () => {
  assert.equal(await openRefreshToken(secret, "v2.abc.def"), null);
  assert.equal(await openRefreshToken(secret, "not-sealed"), null);
});

test("空字串 token 不視為有效", async () => {
  assert.equal(await openRefreshToken(secret, await sealRefreshToken(secret, "")), null);
});
