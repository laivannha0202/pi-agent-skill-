import test from "node:test";
import assert from "node:assert/strict";
import { classifyEngineeringTask, automaticUesAdmission } from "../lib/task-policy.mjs";
import { compileRequirementLedger } from "../lib/requirement-contract.mjs";

// --- Negation / read-only ---
test("deep-reg: 'chỉ kiểm tra, đừng sửa' -> read-only true", () => {
  const p = classifyEngineeringTask("chỉ kiểm tra repository, đừng sửa");
  assert.equal(p.readOnly, true);
});

test("deep-reg: 'chỉ chạy test, không sửa source' -> read-only true", () => {
  const p = classifyEngineeringTask("chỉ chạy test, không sửa source");
  assert.equal(p.readOnly, true);
});

test("deep-reg: 'giải thích thôi' -> not admitted", () => {
  const a = automaticUesAdmission("giải thích thôi");
  assert.equal(a.admit, false);
});

test("deep-reg: 'giải thích cách hoạt động của module X' -> not admitted", () => {
  const a = automaticUesAdmission("giải thích cách hoạt động của module X");
  assert.equal(a.admit, false);
});

// --- Multi-clause compound ---
test("deep-reg: 'sửa file A nhưng không đổi file B' -> MUST + MUST_NOT", () => {
  const l = compileRequirementLedger("sửa file A nhưng không đổi file B");
  assert.equal(l.counts.MUST, 1);
  assert.equal(l.counts.MUST_NOT, 1);
});

test("deep-reg: 'thêm tính năng X, không sửa Y, và chạy test' -> MUST+MUST_NOT+VERIFY", () => {
  const l = compileRequirementLedger("thêm tính năng X, không sửa Y, và chạy test");
  assert.ok(l.counts.MUST >= 1, "MUST");
  assert.ok(l.counts.MUST_NOT >= 1, "MUST_NOT");
  assert.ok(l.counts.VERIFY >= 1, "VERIFY");
});

// --- Negation version ---
test("deep-reg: 'không tăng version' -> MUST_NOT", () => {
  const l = compileRequirementLedger("không tăng version");
  assert.equal(l.counts.MUST_NOT, 1);
  assert.equal(l.counts.MUST, 0);
});

// --- Mixed check-and-fix ---
test("deep-reg: 'test xong mới push' -> VERIFY", () => {
  const l = compileRequirementLedger("test xong mới push");
  assert.equal(l.counts.VERIFY, 1);
});

test("deep-reg: 'sửa lỗi A và chạy test trước khi push' -> MUST + VERIFY", () => {
  const l = compileRequirementLedger("sửa lỗi A và chạy test trước khi push");
  assert.ok(l.counts.MUST >= 1);
  assert.ok(l.counts.VERIFY >= 1);
});

// --- Multi-step long-horizon Vietnamese ---
test("deep-reg: long-horizon Vietnamese refactor classified deep", () => {
  const p = classifyEngineeringTask(
    "Phân tích toàn bộ project hiện tại và thực hiện một refactor lớn nhưng an toàn. Chia công việc thành các task có dependency; cuối cùng phải có integration verification và chỉ finalize khi các gate cho phép.",
  );
  assert.equal(p.mode, "long-horizon");
  assert.equal(p.executionProfile, "deep");
  assert.equal(p.requirePlanCheck, true);
});

// --- Requirement IDs preserved (no drop after negation) ---
test("deep-reg: requirement IDs are sequential and unique", () => {
  const l = compileRequirementLedger("sửa A nhưng không đổi B; chạy test; không tăng version");
  const ids = l.requirements.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  assert.equal(ids[0], "R1");
});

// --- Automatic admission for mixed read+write ---
test("deep-reg: 'chỉ kiểm tra repo, đừng sửa' admitted as read-only engineering", () => {
  const a = automaticUesAdmission("chỉ kiểm tra repository, đừng sửa");
  assert.equal(a.admit, true);
  assert.equal(a.policy.readOnly, true);
});

// --- Denial of implicit completion ---
test("deep-reg: high-risk mutation still high risk", () => {
  const p = classifyEngineeringTask("rotate secret credential in production");
  assert.equal(p.risk, "high");
  assert.equal(p.requirePlanCheck, true);
});
