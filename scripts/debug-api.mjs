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
await probe("getPlcy 기본(메타 확인)", `${base}?apiKeyNm=${key}&pageNum=1&pageSize=2&rtnType=json`);
await probe("getPlcy 키워드검색(서버필터 동작 확인)", `${base}?apiKeyNm=${key}&pageNum=1&pageSize=2&rtnType=json&plcyKywdNm=${encodeURIComponent("월세")}`);
await probe("구버전 youthPlcyList.do", `https://www.youthcenter.go.kr/opi/youthPlcyList.do?openApiVlak=${key}&display=2&pageIndex=1`);
