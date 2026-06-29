import { randomDelay } from "./delay.js";
import { extractEmail } from "./emailExtractor.js";
import { isIndustryMatch } from "./industryFilter.js";
import { companyKey, normalizePhone } from "./normalize.js";
import { KakaoKeywordProvider, NaverLocalProvider } from "./providers.js";
import { normalizeIndustry, scoreIndustry } from "./scoring.js";

export class LeadCollector {
  constructor({ providers = [new KakaoKeywordProvider(), new NaverLocalProvider()], extractEmails = true } = {}) {
    this.providers = providers;
    this.extractEmails = extractEmails;
  }

  async collect({ regions, industries, perQuery, limit = 300, delayMinMs = 3000, delayMaxMs = 8000, onDelay = null }) {
    const result = await this.collectWithStats({ regions, industries, perQuery, limit, delayMinMs, delayMaxMs, onDelay });
    return result.leads;
  }

  async collectWithStats({
    regions,
    industries,
    perQuery,
    limit = 300,
    delayMinMs = 3000,
    delayMaxMs = 8000,
    onDelay = null,
  }) {
    const leads = [];
    const seenLeadKeys = new Set();
    const stats = {
      totalAttempts: 0,
      duplicateExcluded: 0,
      missingPhoneExcluded: 0,
      regionMismatchExcluded: 0,
      industryMismatchExcluded: 0,
    };
    let requestCount = 0;

    for (const region of regions) {
      for (const industry of industries) {
        for (const provider of this.providers) {
          if (requestCount > 0) {
            await randomDelay(delayMinMs, delayMaxMs, onDelay);
          }
          requestCount += 1;

          const rows = await provider.search(region, industry, perQuery);
          for (const row of rows) {
            stats.totalAttempts += 1;

            const lead = await this.makeLead(row, industry, region, stats);
            if (!lead) continue;

            const leadKey = duplicateKey(lead.companyName, lead.phone);
            if (seenLeadKeys.has(leadKey)) {
              stats.duplicateExcluded += 1;
              continue;
            }

            seenLeadKeys.add(leadKey);
            leads.push(lead);
            if (limit > 0 && leads.length >= limit) {
              return { leads, stats };
            }
          }
        }
      }
    }

    return { leads, stats };
  }

  async makeLead(row, fallbackIndustry, region, stats = null) {
    if (!row.companyName || !normalizePhone(row.phone)) {
      if (stats) stats.missingPhoneExcluded += 1;
      return null;
    }
    if (!isRegionMatch(region, row.address)) {
      if (stats) stats.regionMismatchExcluded += 1;
      return null;
    }

    const detailIndustry = normalizeIndustry(fallbackIndustry, row.industry);
    if (!isIndustryMatch(fallbackIndustry, detailIndustry, row.companyName)) {
      if (stats) stats.industryMismatchExcluded += 1;
      return null;
    }

    const email = this.extractEmails && row.homepage ? await extractEmail(row.homepage) : "";
    return {
      companyName: row.companyName,
      industry: fallbackIndustry,
      detailIndustry,
      region,
      address: row.address || "",
      phone: row.phone,
      homepage: row.homepage || "",
      email,
      sourceUrl: row.sourceUrl || "",
      collectedAt: new Date().toISOString().slice(0, 10),
      grade: scoreIndustry(`${fallbackIndustry} ${detailIndustry}`, row.companyName),
      salesStatus: "신규",
      memo: "",
    };
  }
}

export function duplicateKey(companyName, phone) {
  return `${companyKey(companyName)}|${normalizePhone(phone)}`;
}

export function isRegionMatch(region, address = "") {
  if (!address) return true;
  return String(address).includes(region);
}
