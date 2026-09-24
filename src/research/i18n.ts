// Language packs — Uzam's translated frame.
// Rule: numbers, grades (HIGH/MEDIUM/LOW) and quoted evidence are NEVER
// translated. Only headers, labels, the scale legend and the receipt are.
// Evidence excerpts stay in their source language with ev_original noting it.
// Unknown/unsupported codes fall back to English. New language = one object.

export const SUPPORTED_LANGS = ["en", "zh", "es", "fr"] as const;
export type LangCode = (typeof SUPPORTED_LANGS)[number];

type Dict = Record<string, string>;

const en: Dict = {
  sec_premium: "Premium vs reference",
  sec_backing: "Backing",
  sec_filings: "Underlying filings & dividends",
  sec_risks: "All risks (ranked)",
  sec_checked: "What we checked / couldn't prove",
  sec_evidence: "Key evidence",
  sec_recent: "Recent developments",
  sec_contradictions: "Contradictions",
  sec_deltas: "Deltas",
  sec_leaders: "Leaders (per category, evidence-based — not overall recommendations)",
  sec_whales: "Shared whales (top holders recurring across tokens)",
  lbl_checked: "Checked",
  lbl_couldnt: "Couldn't prove",
  lbl_holders: "Holders",
  lbl_liquidity: "Liquidity",
  lbl_custodian: "Custodian",
  lbl_overall: "Overall confidence",
  lbl_backing: "Backing",
  scale: "Scale: HIGH = multiple sources agree · MEDIUM = partly supported · LOW = thin or failed sources · UNKNOWN = no evidence",
  sev_low: "low",
  sev_moderate: "moderate",
  sev_high: "high",
  sev_unknown: "unknown",
  cmp_title: "Comparison",
  cmp_cheapest: "Cheapest premium",
  cmp_liquid: "Most liquid",
  cmp_dispersed: "Least concentrated",
  rpt_paid: "Paid",
  rpt_free: "Free via MCP",
  rpt_endpoints: "OKX endpoints",
  rpt_pages: "page(s)",
  rpt_reports: "full report(s)",
  rpt_in: "in",
  ev_original: "(quoted in original language, untranslated)",
  id_summary_of: "Official docs",
  id_backing_note: "backing unverified — see analyze_backing",
  id_unknown: "Asset not in Uzam X Layer MVP registry. Do not guess. Resolve via OKX token search on chainIndex 196 or the xStocks tokenlist.",
  id_no_contract: "Resolve exact contract via OKX token search (chainIndex 196) or tokenlist. No address hardcoded.",
  detail_only_en: "Detail sections are English in this version; translated summaries ship in research_asset / compare_assets / identify_asset.",
};

const zh: Dict = {
  sec_premium: "溢价与参考价",
  sec_backing: "资产支撑",
  sec_filings: "标的公司财报与分红",
  sec_risks: "风险排行（全部）",
  sec_checked: "已核查 / 未能证实",
  sec_evidence: "关键证据",
  sec_recent: "最新动态",
  sec_contradictions: "矛盾点",
  sec_deltas: "差异对比",
  sec_leaders: "各维度领先者（基于证据，非整体推荐）",
  sec_whales: "跨币种巨鲸持仓（在多个币种中重复出现的头部持有人）",
  lbl_checked: "已核查",
  lbl_couldnt: "未能证实",
  lbl_holders: "持有人",
  lbl_liquidity: "流动性",
  lbl_custodian: "托管方",
  lbl_overall: "总体可信度",
  lbl_backing: "资产支撑",
  scale: "评级说明：HIGH = 多个来源一致 · MEDIUM = 部分支持 · LOW = 证据薄弱或缺失 · UNKNOWN = 无证据",
  sev_low: "低",
  sev_moderate: "中等",
  sev_high: "高",
  sev_unknown: "未知",
  cmp_title: "对比",
  cmp_cheapest: "最低溢价",
  cmp_liquid: "流动性最高",
  cmp_dispersed: "持仓最分散",
  rpt_paid: "已付费",
  rpt_free: "通过 MCP 免费",
  rpt_endpoints: "个 OKX 数据接口",
  rpt_pages: "个官方页面",
  rpt_reports: "份完整报告",
  rpt_in: "耗时",
  ev_original: "（原文引用，未翻译）",
  id_summary_of: "官方文档",
  id_backing_note: "支撑情况未经核实——见 analyze_backing",
  id_unknown: "该资产不在 Uzam X Layer 注册表中。请勿猜测。请通过 chainIndex 196 上的 OKX 代币搜索或 xStocks 代币列表确认。",
  id_no_contract: "请通过 OKX 代币搜索（chainIndex 196）或代币列表确认准确合约地址。此处不硬编码任何地址。",
  detail_only_en: "详情部分当前仅提供英文；research_asset / compare_assets / identify_asset 提供翻译后的摘要。",
};

const es: Dict = {
  sec_premium: "Prima frente a la referencia",
  sec_backing: "Respaldo",
  sec_filings: "Informes y dividendos del subyacente",
  sec_risks: "Todos los riesgos (ordenados)",
  sec_checked: "Lo verificado / lo no probado",
  sec_evidence: "Evidencia clave",
  sec_recent: "Novedades recientes",
  sec_contradictions: "Contradicciones",
  sec_deltas: "Diferencias",
  sec_leaders: "Líderes (por categoría, con evidencia — no son recomendaciones generales)",
  sec_whales: "Ballenas compartidas (grandes tenedores en varios tokens)",
  lbl_checked: "Verificado",
  lbl_couldnt: "No se pudo probar",
  lbl_holders: "Tenedores",
  lbl_liquidity: "Liquidez",
  lbl_custodian: "Custodio",
  lbl_overall: "Confianza general",
  lbl_backing: "Respaldo",
  scale: "Escala: HIGH = varias fuentes coinciden · MEDIUM = respaldo parcial · LOW = evidencia escasa o fallida · UNKNOWN = sin evidencia",
  sev_low: "bajo",
  sev_moderate: "moderado",
  sev_high: "alto",
  sev_unknown: "desconocido",
  cmp_title: "Comparación",
  cmp_cheapest: "Prima más barata",
  cmp_liquid: "Más líquido",
  cmp_dispersed: "Menos concentrado",
  rpt_paid: "Pagado",
  rpt_free: "Gratis vía MCP",
  rpt_endpoints: "puntos OKX",
  rpt_pages: "página(s)",
  rpt_reports: "informe(s)",
  rpt_in: "en",
  ev_original: "(citado en el idioma original, sin traducir)",
  id_summary_of: "Documentos oficiales",
  id_backing_note: "respaldo sin verificar — ver analyze_backing",
  id_unknown: "Activo fuera del registro MVP de Uzam en X Layer. No adivinar. Resolver mediante búsqueda OKX en chainIndex 196 o la tokenlist de xStocks.",
  id_no_contract: "Resolver el contrato exacto vía búsqueda OKX (chainIndex 196) o la tokenlist. Sin direcciones fijas.",
  detail_only_en: "Las secciones de detalle están en inglés en esta versión; research_asset / compare_assets / identify_asset ofrecen resúmenes traducidos.",
};

const fr: Dict = {
  sec_premium: "Prime par rapport à la référence",
  sec_backing: "Adossement",
  sec_filings: "Publications et dividendes du sous-jacent",
  sec_risks: "Tous les risques (classés)",
  sec_checked: "Vérifié / non prouvé",
  sec_evidence: "Preuves clés",
  sec_recent: "Actualités récentes",
  sec_contradictions: "Contradictions",
  sec_deltas: "Écarts",
  sec_leaders: "Leaders (par catégorie, fondés sur des preuves — pas des recommandations globales)",
  sec_whales: "Baleines partagées (grands détenteurs sur plusieurs tokens)",
  lbl_checked: "Vérifié",
  lbl_couldnt: "Non prouvé",
  lbl_holders: "Détenteurs",
  lbl_liquidity: "Liquidité",
  lbl_custodian: "Dépositaire",
  lbl_overall: "Confiance globale",
  lbl_backing: "Adossement",
  scale: "Échelle : HIGH = plusieurs sources concordent · MEDIUM = partiellement étayé · LOW = preuves minces ou manquantes · UNKNOWN = aucune preuve",
  sev_low: "faible",
  sev_moderate: "modéré",
  sev_high: "élevé",
  sev_unknown: "inconnu",
  cmp_title: "Comparaison",
  cmp_cheapest: "Prime la moins chère",
  cmp_liquid: "Le plus liquide",
  cmp_dispersed: "Le moins concentré",
  rpt_paid: "Payé",
  rpt_free: "Gratuit via MCP",
  rpt_endpoints: "points OKX",
  rpt_pages: "page(s)",
  rpt_reports: "rapport(s)",
  rpt_in: "en",
  ev_original: "(cité dans la langue d'origine, non traduit)",
  id_summary_of: "Documents officiels",
  id_backing_note: "adossement non vérifié — voir analyze_backing",
  id_unknown: "Actif absent du registre MVP Uzam sur X Layer. Ne pas deviner. Résoudre via la recherche OKX sur chainIndex 196 ou la tokenlist xStocks.",
  id_no_contract: "Résoudre le contrat exact via la recherche OKX (chainIndex 196) ou la tokenlist. Aucune adresse codée en dur.",
  detail_only_en: "Les sections détaillées sont en anglais dans cette version ; research_asset / compare_assets / identify_asset fournissent des résumés traduits.",
};

const PACKS: Record<string, Dict> = { en, zh, es, fr };

/** Normalize any input to a supported code; everything else becomes "en". */
export function normalizeLang(input: unknown): LangCode {
  if (typeof input !== "string") return "en";
  const code = input.trim().toLowerCase().slice(0, 10);
  if ((SUPPORTED_LANGS as readonly string[]).includes(code)) return code as LangCode;
  const base = code.split("-")[0];
  if ((SUPPORTED_LANGS as readonly string[]).includes(base)) return base as LangCode;
  return "en";
}

/** Translate a UI key; falls back to English, then to the key itself. */
export function t(lang: LangCode, key: string): string {
  return PACKS[lang]?.[key] ?? en[key] ?? key;
}

/** Severity code (low/moderate/high/unknown) in the user's language. */
export function sev(lang: LangCode, severity: string): string {
  return t(lang, `sev_${severity}`) ;
}
