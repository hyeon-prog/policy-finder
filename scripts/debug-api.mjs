#!/usr/bin/env node
/** 온통청년 API 진단 프로브 — 응답 메타·검색·구버전 엔드포인트 확인 (키는 출력에서 마스킹) */
const key = process.env.YOUTH_API_KEY;
if (!key) { console.log("YOUTH_API_KEY 없음"); process.exit(0); }

async function probe(label, url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const t = (await r.text()).replace(/\s+/g, " ").slice(0, 700).replaceAll(key, "***");
    console.log(`== ${label} (HTTP ${r.status}):`, t);
  } catch (e) {
    console.log(`== ${label} ERROR:`, e.message);
  }
}

const base = "https://www.youthcenter.go.kr/go/ythip/getPlcy";
await probe("getPlcy 기본키", `${base}?apiKeyNm=${key}&pageNum=1&pageSize=1&rtnType=json`);

// 두 번째 시크릿(YOUTH_API_KEY_2)이 있으면 그 키도 테스트
const key2 = process.env.YOUTH_API_KEY_2;
if (key2 && key2 !== key) {
  const r = await fetch(`${base}?apiKeyNm=${key2}&pageNum=1&pageSize=1&rtnType=json`, { signal: AbortSignal.timeout(20000) });
  const t = (await r.text()).replace(/\s+/g, " ").slice(0, 700).replaceAll(key2, "***").replaceAll(key, "***");
  console.log(`== getPlcy 두번째키 (HTTP ${r.status}):`, t);
} else {
  console.log("== 두번째키 없음 또는 동일");
}
