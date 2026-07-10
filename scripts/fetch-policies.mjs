#!/usr/bin/env node
/**
 * =====================================================================
 * 온통청년 청년정책 Open API → data/policies.json 생성 스크립트
 * ---------------------------------------------------------------------
 * 실행:  YOUTH_API_KEY=<인증키> node scripts/fetch-policies.mjs
 * 테스트: YOUTH_API_MOCK=<mock.json 경로> node scripts/fetch-policies.mjs
 *
 * 동작 원칙 (실서비스 안전장치):
 *  - 인증키가 없으면 큐레이션 데이터(data/curated.json)만으로 재생성하고 종료
 *  - API 응답이 예상 형태가 아니면 기존 policies.json을 건드리지 않고 실패 종료
 *  - API 항목은 큐레이션 항목과 이름이 겹치면 제외(중복 방지)
 *
 * GitHub Actions(.github/workflows/update-data.yml)가 매일 실행합니다.
 * 인증키 발급: 온통청년(youthcenter.go.kr) 회원가입 → 오픈API 인증키 신청
 * ===================================================================== */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const API_URL = "https://www.youthcenter.go.kr/go/ythip/getPlcy";
const MAX_API_ITEMS = 30; // 페이지 성능을 위해 API 항목 수 제한

/* ---------------- 코드 → 값 매핑 테이블 ---------------- */

// 법정동코드 앞 2자리 → 시/도명
const SIDO_BY_PREFIX = {
  "11": "서울특별시", "26": "부산광역시", "27": "대구광역시", "28": "인천광역시",
  "29": "광주광역시", "30": "대전광역시", "31": "울산광역시", "36": "세종특별자치시",
  "41": "경기도", "43": "충청북도", "44": "충청남도", "46": "전라남도",
  "47": "경상북도", "48": "경상남도", "50": "제주특별자치도",
  "51": "강원특별자치도", "52": "전북특별자치도",
};

// 정책 대분류 → 사이트 카테고리
const CATEGORY_BY_LCLSF = {
  "일자리": "취업", "주거": "주거", "교육": "교육",
  "복지문화": "생활지원", "참여권리": "참여·권리",
};

// 취업요건코드 → 사이트 취업상태 값 (알 수 없는 코드는 '무관' 처리)
const JOB_CODE_MAP = {
  "0013001": "employed",      // 재직자
  "0013002": "self-employed", // 자영업자
  "0013003": "jobseeker",     // 미취업자
  "0013004": "freelancer",    // 프리랜서
};

/* ---------------- 유틸 ---------------- */

const clean = (v) =>
  String(v ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

const num = (v) => {
  const n = parseInt(String(v ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

/** KST 기준 오늘 날짜 YYYYMMDD */
function todayYmdKst() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

/** 이름 정규화 — 중복 판단용 (공백·괄호·특수문자 제거) */
const normName = (s) => clean(s).replace(/[\s()\[\]「」·+ⅠⅡ\-~]/g, "");

/* ---------------- 필드 매핑 ---------------- */

/** zipCd(법정동코드 목록) → 시/도명 배열. 10개 시/도 이상이면 전국으로 간주 */
function parseRegions(zipCd) {
  const prefixes = new Set(
    String(zipCd ?? "").split(",").map((s) => s.trim().slice(0, 2)).filter(Boolean)
  );
  const sidos = [...new Set([...prefixes].map((p) => SIDO_BY_PREFIX[p]).filter(Boolean))];
  if (sidos.length === 0 || sidos.length >= 10) return ["전국"];
  return sidos;
}

/**
 * 신청기간 판정 → { open, deadline }
 * 실제 목록 응답에는 aplyYmd가 없고 aplyPrdSeCd(구분코드)와
 * bizPrdBgngYmd/bizPrdEndYmd(사업기간)만 옵니다.
 * 코드: 0057001 특정기간 / 0057002 상시 / 0057003 마감
 */
function parseApply(raw, today) {
  // 혹시 상세형 응답에 aplyYmd("20260101 ~ 20261231")가 있으면 우선 사용
  const ymd = clean(raw.aplyYmd);
  const m = ymd.match(/(\d{8})\s*~\s*(\d{8})/);
  if (m) {
    const open = today >= m[1] && today <= m[2];
    const fmt = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    return { open, deadline: `${fmt(m[1])} ~ ${fmt(m[2])}${open ? "" : " (접수 기간 아님)"}` };
  }

  const se = clean(raw.aplyPrdSeCd);
  if (se === "0057003") return { open: false, deadline: "접수 마감 (공고 확인)" };

  const end = clean(raw.bizPrdEndYmd).replace(/\D/g, "");
  if (end.length === 8 && end < today) {
    return { open: false, deadline: `사업기간 종료 (~${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)})` };
  }
  if (se === "0057001") return { open: true, deadline: "기간제 모집 — 상세 공고에서 접수기간 확인" };
  return { open: true, deadline: "상시 신청 (상세 공고 확인)" };
}

/** 주관기관명으로 정부정책/지자체 구분 (중앙부처는 보통 부·처·청·위원회로 끝남) */
function classifyType(raw) {
  const org = clean(raw.sprvsnInstCdNm || raw.rgtrUpInstCdNm || raw.operInstCdNm);
  if (/(특별시|광역시|자치시|자치도|도청|시청|군청|구청)/.test(org)) return "local";
  if (/(도|시|군|구)$/.test(org) && !/(공사|공단|진흥원|재단|연구원)$/.test(org)) return "local";
  return "policy";
}

/** API 원본 1건 → 사이트 아이템 스키마 */
function mapPolicy(raw, today) {
  const { open, deadline } = parseApply(raw, today);
  const minAge = num(raw.sprtTrgtMinAge);
  const maxAge = num(raw.sprtTrgtMaxAge);
  const employment = [
    ...new Set(
      String(raw.jobCd ?? "").split(",")
        .map((c) => JOB_CODE_MAP[c.trim()])
        .filter(Boolean)
    ),
  ];

  const ageText =
    minAge || maxAge ? `만 ${minAge ?? "제한없음"}~${maxAge ?? "제한없음"}세` : "";
  const targetSrc = clean(raw.addAplyQlfcCndCn) || clean(raw.plcyExplnCn);

  return {
    id: `yc-${clean(raw.plcyNo) || normName(raw.plcyNm).slice(0, 20)}`,
    type: classifyType(raw),
    open,
    source: "youthcenter",
    name: trunc(clean(raw.plcyNm), 60),
    category: CATEGORY_BY_LCLSF[clean(raw.lclsfNm)] || clean(raw.mclsfNm) || "기타",
    summary: trunc(clean(raw.plcySprtCn) || clean(raw.plcyExplnCn) || "상세 공고 참조", 90),
    target: trunc([ageText, targetSrc].filter(Boolean).join(" — ") || "상세 공고 참조", 130),
    deadline,
    applyMethod: trunc(clean(raw.plcyAplyMthdCn) || "온라인/방문 신청 (상세 공고 확인)", 80),
    link: clean(raw.aplyUrlAddr) || clean(raw.refUrlAddr1) || "https://www.youthcenter.go.kr",
    eligibility: {
      minAge: minAge && minAge > 0 ? minAge : null,
      maxAge: maxAge && maxAge > 0 && maxAge < 120 ? maxAge : null,
      regions: parseRegions(raw.zipCd),
      maxIncomeRatio: null,   // API 소득 조건은 서술형이라 매칭에 사용하지 않음
      employment: employment.length ? employment : null,
      maritalStatus: null,     // 혼인 코드 매핑은 보수적으로 무관 처리
      requiresChildren: false,
      minHouseholdSize: null,
    },
  };
}

/* ---------------- 메인 ---------------- */

async function fetchApiList(key) {
  // 테스트용 목 응답 (YOUTH_API_MOCK=파일경로)
  if (process.env.YOUTH_API_MOCK) {
    return JSON.parse(readFileSync(process.env.YOUTH_API_MOCK, "utf8"));
  }
  const params = new URLSearchParams({
    apiKeyNm: key, pageNum: "1", pageSize: "100", rtnType: "json",
  });
  const res = await fetch(`${API_URL}?${params}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const curated = JSON.parse(readFileSync(path.join(ROOT, "data", "curated.json"), "utf8"));
const outPath = path.join(ROOT, "data", "policies.json");
const key = process.env.YOUTH_API_KEY;

let apiItems = [];
let source = "curated";

if (!key && !process.env.YOUTH_API_MOCK) {
  console.log("YOUTH_API_KEY 미설정 — 큐레이션 데이터만으로 생성합니다.");
} else {
  const json = await fetchApiList(key);
  const list = json?.result?.youthPolicyList;
  if (!Array.isArray(list)) {
    // 예상 밖 응답이면 기존 파일을 건드리지 않고 실패 (Actions 로그로 확인)
    console.error("API 응답 형식이 예상과 다릅니다:", JSON.stringify(json).slice(0, 300));
    process.exit(1);
  }
  // 진단 모드: 실제 응답 필드 확인용 (DEBUG_DUMP=1)
  if (process.env.DEBUG_DUMP) {
    console.log("FIELD KEYS:", Object.keys(list[0] || {}).join(","));
    console.log("SAMPLE ITEMS:", JSON.stringify(list.slice(0, 2)).slice(0, 3500));
    const aplyStats = {};
    list.forEach((r) => {
      const s = clean(r.aplyYmd).slice(0, 25) || "(empty)";
      aplyStats[s] = (aplyStats[s] || 0) + 1;
    });
    console.log("APLY SAMPLES:", JSON.stringify(Object.entries(aplyStats).slice(0, 12)));
  }

  const today = todayYmdKst();
  const curatedNames = curated.items.map((it) => normName(it.name));
  const seen = new Set();

  apiItems = list
    .map((raw) => mapPolicy(raw, today))
    .filter((it) => it.name)                                   // 필드 마스킹·불량 행 제외 (키 승인 전엔 전부 null)
    .filter((it) => it.open)                                   // 접수 중인 것만
    .filter((it) => {                                          // 큐레이션과 중복 제거
      const n = normName(it.name);
      if (!n || seen.has(n)) return false;
      seen.add(n);
      return !curatedNames.some((c) => n.includes(c) || c.includes(n));
    })
    .slice(0, MAX_API_ITEMS);
  source = apiItems.length ? "curated+youthcenter" : "curated";
  console.log(`API ${list.length}건 중 ${apiItems.length}건 채택 (유효·접수중·중복제거 후)`);
  if (list.length > 0 && apiItems.length === 0 && !clean(list[0].plcyNm)) {
    console.log("⚠️ 응답 필드가 전부 비어 있습니다 — 인증키가 아직 승인 대기 상태일 수 있습니다.");
  }
}

const output = {
  verifiedAt: curated.verifiedAt,
  generatedAt: new Date().toISOString(),
  source,
  items: [...curated.items, ...apiItems],
};

// 실질 내용이 같으면 파일을 덮어쓰지 않음 (generatedAt만 바뀌는 커밋 방지)
let unchanged = false;
try {
  const prev = JSON.parse(readFileSync(outPath, "utf8"));
  unchanged =
    JSON.stringify({ ...prev, generatedAt: null }) ===
    JSON.stringify({ ...output, generatedAt: null });
} catch { /* 기존 파일이 없거나 손상 → 새로 작성 */ }

if (unchanged) {
  console.log("데이터 내용 변화 없음 — policies.json 유지");
} else {
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`data/policies.json 생성 완료 — 총 ${output.items.length}건 (source: ${source})`);
}
