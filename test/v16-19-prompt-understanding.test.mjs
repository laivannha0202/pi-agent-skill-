import test from "node:test";
import assert from "node:assert/strict";
import { classifyEngineeringTask, automaticUesAdmission } from "../lib/task-policy.mjs";
import { compileRequirementLedger } from "../lib/requirement-contract.mjs";

test("V16.19 P1: 'chỉ kiểm tra, đừng sửa' is read-only and not a mutation", () => {
  const policy = classifyEngineeringTask("chỉ kiểm tra repository, đừng sửa");
  assert.equal(policy.readOnly, true);
});

test("V16.19 P1: 'giải thích thôi' is not admitted as engineering task", () => {
  const admission = automaticUesAdmission("giải thích thôi");
  assert.equal(admission.admit, false);
});

test("V16.19 P1: 'sửa file A nhưng không đổi file B' splits MUST and MUST_NOT", () => {
  const ledger = compileRequirementLedger("sửa file A nhưng không đổi file B");
  assert.equal(ledger.counts.MUST, 1);
  assert.equal(ledger.counts.MUST_NOT, 1);
});

test("V16.19 P1: 'không tăng version' is a MUST_NOT constraint", () => {
  const ledger = compileRequirementLedger("không tăng version");
  assert.equal(ledger.counts.MUST_NOT, 1);
});

test("V16.19 P1: 'test xong mới push' is a VERIFY requirement", () => {
  const ledger = compileRequirementLedger("test xong mới push");
  assert.equal(ledger.counts.VERIFY, 1);
});

test("V16.19 P1: 'chỉ kiểm tra, đừng sửa' yields VERIFY + MUST_NOT", () => {
  const ledger = compileRequirementLedger("chỉ kiểm tra, đừng sửa");
  assert.equal(ledger.counts.VERIFY, 1);
  assert.equal(ledger.counts.MUST_NOT, 1);
});
