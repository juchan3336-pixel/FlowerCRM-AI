import assert from "node:assert/strict";
import test from "node:test";

import { isIndustryMatch } from "../src/industryFilter.js";

test("accepts broader valid Kakao industry labels", () => {
  assert.equal(isIndustryMatch("회계사무소", "세무회계사무소", "한빛세무회계사무소"), true);
  assert.equal(isIndustryMatch("회계법인", "서비스,산업 > 전문대행 > 공인회계사", "신원회계법인"), true);
  assert.equal(isIndustryMatch("세무사무소", "세무회계", "김기찬세무회계사무소"), true);
  assert.equal(isIndustryMatch("법률사무소", "법무사사무소", "새울산법무사사무소"), true);
  assert.equal(isIndustryMatch("의원", "클리닉", "서울피부과클리닉"), true);
  assert.equal(isIndustryMatch("자동차판매점", "자동차영업소", "현대자동차 울산판매대리점"), true);
});
