-- ============================================================
-- SPRINT 5: FAQ ENGINE SEED – v2 (PORTABLE)
-- 10 Produkte × 4-6 FAQs × DE + EN
-- Datum: 2026-06-14 | ZERO RISK – nur INSERT ... ON CONFLICT DO NOTHING
-- Compliance: "Research Use Only" Framing – keine medizinischen Aussagen
-- schema_enabled=1 → erscheint in Schema.org FAQPage (Rich Results)
-- ============================================================
-- PORTABLE: Alle article_ids werden per Subquery aus shopProductId ermittelt.
-- Keine festen IDs. Funktioniert auf DEV, TEST und PROD.
-- Produkte dürfen neu importiert werden – FAQs bleiben intakt.
-- Idempotent: ON CONFLICT (article_id, lang, question) DO NOTHING
-- ============================================================

-- ============================================================
-- 1. RETATRUTIDE (shopProductId: '3g-triple-g')
-- ============================================================
INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was ist Retatrutide und warum wird es in der Forschung untersucht?',
  'Retatrutide (auch bekannt als LY3437943 oder "3G") ist ein tri-agonistisches Peptid, das GLP-1-, GIP- und Glucagon-Rezeptoren gleichzeitig aktiviert. In klinischen Studien wird es auf seine Wirkung auf Körpergewicht, Glukosestoffwechsel und kardiovaskuläre Parameter untersucht. 369 Research bietet Retatrutide ausschließlich für Forschungszwecke an (Research Use Only).',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='3g-triple-g' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was unterscheidet Retatrutide von Tirzepatide in der Forschung?',
  'Während Tirzepatide ein dualer GLP-1/GIP-Agonist ist, aktiviert Retatrutide zusätzlich den Glucagon-Rezeptor (tri-agonistisch). In Forschungsstudien zeigt Retatrutide stärkere Effekte auf die Gewichtsreduktion. Beide Verbindungen sind Research Use Only und nicht für den menschlichen Gebrauch zugelassen.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='3g-triple-g' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Studien gibt es zu Retatrutide?',
  'Phase-2-Studien (NCT04881760) haben Retatrutide auf seine Wirkung auf Körpergewicht und metabolische Parameter untersucht. Die Ergebnisse wurden im New England Journal of Medicine publiziert. Alle Studien wurden unter kontrollierten klinischen Bedingungen durchgeführt. Unsere Produkte sind ausschließlich für wissenschaftliche Forschungszwecke bestimmt.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='3g-triple-g' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Wie wird Retatrutide bei 369 Research hergestellt?',
  'Retatrutide von 369 Research wird in EU-zertifizierten Labors synthetisiert und auf >99% Reinheit geprüft. Jede Charge wird mit HPLC und Massenspektrometrie analysiert. Laborreports sind auf Anfrage erhältlich. Research Use Only – nicht für menschliche Anwendung.',
  4, 1, 1 FROM articles a WHERE a."shopProductId"='3g-triple-g' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Für wen ist Retatrutide von 369 Research geeignet?',
  'Retatrutide von 369 Research ist ausschließlich für qualifizierte Forscher, Wissenschaftler und Labore bestimmt, die metabolische Forschung betreiben. Es ist kein Nahrungsergänzungsmittel und nicht für den menschlichen Gebrauch zugelassen. Research Use Only.',
  5, 1, 1 FROM articles a WHERE a."shopProductId"='3g-triple-g' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What is Retatrutide and why is it studied in research?',
  'Retatrutide (LY3437943, "3G") is a tri-agonistic peptide that simultaneously activates GLP-1, GIP, and glucagon receptors. Clinical studies investigate its effects on body weight, glucose metabolism, and cardiovascular parameters. 369 Research offers Retatrutide exclusively for research purposes (Research Use Only).',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='3g-triple-g' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'How does Retatrutide differ from Tirzepatide in research?',
  'While Tirzepatide is a dual GLP-1/GIP agonist, Retatrutide additionally activates the glucagon receptor (tri-agonistic). Research studies show stronger weight reduction effects with Retatrutide. Both compounds are Research Use Only and not approved for human use.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='3g-triple-g' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What studies exist on Retatrutide?',
  'Phase 2 studies (NCT04881760) have investigated Retatrutide for its effects on body weight and metabolic parameters. Results were published in the New England Journal of Medicine. All studies were conducted under controlled clinical conditions. Our products are exclusively for scientific research purposes.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='3g-triple-g' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What is the purity of Retatrutide from 369 Research?',
  'Retatrutide from 369 Research is synthesized in EU-certified laboratories and tested for >99% purity. Each batch is analyzed by HPLC and mass spectrometry. Lab reports are available on request. Research Use Only – not for human application.',
  4, 1, 1 FROM articles a WHERE a."shopProductId"='3g-triple-g' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

-- ============================================================
-- 2. TIRZEPATIDE (shopProductId: 'tirzepatide')
-- ============================================================
INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was ist Tirzepatide und wie unterscheidet es sich von GLP-1-Monotherapien?',
  'Tirzepatide ist ein dualer GLP-1/GIP-Agonist (Twincretin), der beide Inkretin-Rezeptoren gleichzeitig aktiviert. Im Vergleich zu reinen GLP-1-Agonisten zeigt Tirzepatide in Forschungsstudien stärkere Effekte auf Glukosekontrolle und Körpergewicht. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='tirzepatide' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Mechanismen von Tirzepatide werden in der Forschung untersucht?',
  'Forschungsstudien untersuchen: GLP-1-Rezeptor-Aktivierung (Insulinsekretion, Glukagonhemmung), GIP-Rezeptor-Aktivierung (Insulinsensitivität, Fettgewebe-Metabolismus), Effekte auf Magenentleerung und Sättigungsgefühl sowie kardiovaskuläre Parameter. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='tirzepatide' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche klinischen Studien gibt es zu Tirzepatide?',
  'Die SURPASS-Studienreihe (Phase 3) hat Tirzepatide bei Typ-2-Diabetes und Adipositas untersucht. Ergebnisse wurden im NEJM und anderen Fachzeitschriften publiziert. Research Use Only – unsere Produkte sind ausschließlich für wissenschaftliche Forschung.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='tirzepatide' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Qualitätsstandards hat Tirzepatide von 369 Research?',
  'Tirzepatide von 369 Research wird auf >99% Reinheit geprüft. HPLC-Analyse und Massenspektrometrie für jede Charge. EU-zertifizierte Laborproduktion. Research Use Only.',
  4, 1, 1 FROM articles a WHERE a."shopProductId"='tirzepatide' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What is Tirzepatide and how does it differ from GLP-1 monotherapies?',
  'Tirzepatide is a dual GLP-1/GIP agonist (twincretin) that simultaneously activates both incretin receptors. Compared to pure GLP-1 agonists, research studies show stronger effects on glucose control and body weight. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='tirzepatide' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What mechanisms of Tirzepatide are studied in research?',
  'Research studies investigate: GLP-1 receptor activation (insulin secretion, glucagon inhibition), GIP receptor activation (insulin sensitivity, adipose tissue metabolism), effects on gastric emptying and satiety, and cardiovascular parameters. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='tirzepatide' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What clinical studies exist on Tirzepatide?',
  'The SURPASS study series (Phase 3) investigated Tirzepatide in type 2 diabetes and obesity. Results were published in NEJM and other journals. Research Use Only – our products are exclusively for scientific research.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='tirzepatide' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What purity does Tirzepatide from 369 Research have?',
  'Tirzepatide from 369 Research is tested for >99% purity. HPLC analysis and mass spectrometry for each batch. EU-certified laboratory production. Research Use Only.',
  4, 1, 1 FROM articles a WHERE a."shopProductId"='tirzepatide' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

-- ============================================================
-- 3. GHK-Cu (shopProductId: 'ghk-cu')
-- ============================================================
INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was ist GHK-Cu und welche Rolle spielt es in der Hautforschung?',
  'GHK-Cu (Glycyl-L-Histidyl-L-Lysin-Kupfer) ist ein natürlich vorkommendes Kupfer-Peptid, das in der Forschung auf seine Wirkung auf Kollagensynthese, Wundheilung und Hautalterung untersucht wird. Es stimuliert in Studien die Produktion von Kollagen Typ I und III. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='ghk-cu' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Mechanismen von GHK-Cu werden in der Forschung untersucht?',
  'Forschungsstudien untersuchen: Stimulation von Kollagen Typ I, III und Elastin, Aktivierung von Wachstumsfaktoren (TGF-β, VEGF), antioxidative Wirkung über Kupfer-Chelierung, Regulierung von MMP-Aktivität (Matrix-Metalloproteasen) sowie Effekte auf Wundheilung und Geweberegeneration. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='ghk-cu' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was ist der Unterschied zwischen GHK-Cu Daily und Post Needling?',
  '369 Research bietet GHK-Cu in zwei Formulierungen: Daily für tägliche topische Anwendung in der kosmetischen Forschung und Post Needling für den Einsatz nach Microneedling-Behandlungen. Beide sind Research Use Only und nicht für therapeutische Anwendungen bestimmt.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='ghk-cu' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Reinheit hat GHK-Cu von 369 Research?',
  'GHK-Cu von 369 Research wird auf >98% Reinheit geprüft und in EU-zertifizierten Labors hergestellt. HPLC-Analyse für jede Charge. Research Use Only.',
  4, 1, 1 FROM articles a WHERE a."shopProductId"='ghk-cu' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What is GHK-Cu and what role does it play in skin research?',
  'GHK-Cu (Glycyl-L-Histidyl-L-Lysine-Copper) is a naturally occurring copper peptide studied for its effects on collagen synthesis, wound healing, and skin aging. Research studies show stimulation of Collagen Type I and III production. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='ghk-cu' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What mechanisms of GHK-Cu are studied in research?',
  'Research studies investigate: stimulation of Collagen Type I, III and Elastin, activation of growth factors (TGF-β, VEGF), antioxidant effects via copper chelation, regulation of MMP activity, and effects on wound healing and tissue regeneration. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='ghk-cu' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What purity does GHK-Cu from 369 Research have?',
  'GHK-Cu from 369 Research is tested for >98% purity and manufactured in EU-certified laboratories. HPLC analysis for each batch. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='ghk-cu' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

-- ============================================================
-- 4. BPC-157 (shopProductId: 'bpc-157')
-- ============================================================
INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was ist BPC-157 und warum wird es in der Regenerationsforschung untersucht?',
  'BPC-157 (Body Protection Compound-157) ist ein synthetisches Pentadecapeptid, das aus dem Magenprotein BPC abgeleitet ist. In präklinischen Studien wird es auf seine Wirkung auf Wundheilung, Sehnen- und Muskelregeneration sowie gastrointestinalen Schutz untersucht. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='bpc-157' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Mechanismen von BPC-157 werden in der Forschung untersucht?',
  'Forschungsstudien untersuchen: Aktivierung von VEGF und Angiogenese, Modulation von NO-Synthase, Stimulation von Wachstumsfaktoren (EGF, FGF), Effekte auf GABAerge und dopaminerge Signalwege sowie Schutz der Magenschleimhaut. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='bpc-157' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was unterscheidet BPC-157 von TB-500 in der Forschung?',
  'BPC-157 und TB-500 werden beide in der Regenerationsforschung untersucht, wirken aber über unterschiedliche Mechanismen. BPC-157 stimuliert primär Angiogenese und Wachstumsfaktoren. TB-500 (Thymosin Beta-4) reguliert Aktin-Polymerisation und Zellmigration. Beide sind Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='bpc-157' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Reinheit hat BPC-157 von 369 Research?',
  'BPC-157 von 369 Research wird auf >99% Reinheit geprüft und in EU-zertifizierten Labors hergestellt. HPLC-Analyse und Massenspektrometrie für jede Charge. Laborreports auf Anfrage. Research Use Only.',
  4, 1, 1 FROM articles a WHERE a."shopProductId"='bpc-157' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What is BPC-157 and why is it studied in regeneration research?',
  'BPC-157 (Body Protection Compound-157) is a synthetic pentadecapeptide derived from the gastric protein BPC. Preclinical studies investigate its effects on wound healing, tendon and muscle regeneration, and gastrointestinal protection. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='bpc-157' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What mechanisms of BPC-157 are studied in research?',
  'Research studies investigate: activation of VEGF and angiogenesis, modulation of NO synthase, stimulation of growth factors (EGF, FGF), effects on GABAergic and dopaminergic signaling, and gastric mucosal protection. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='bpc-157' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What distinguishes BPC-157 from TB-500 in research?',
  'BPC-157 and TB-500 are both studied in regeneration research but act through different mechanisms. BPC-157 primarily stimulates angiogenesis and growth factors. TB-500 (Thymosin Beta-4) regulates actin polymerization and cell migration. Both are Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='bpc-157' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What purity does BPC-157 from 369 Research have?',
  'BPC-157 from 369 Research is tested for >99% purity and manufactured in EU-certified laboratories. HPLC analysis and mass spectrometry for each batch. Lab reports available on request. Research Use Only.',
  4, 1, 1 FROM articles a WHERE a."shopProductId"='bpc-157' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

-- ============================================================
-- 5. TB-500 (shopProductId: 'tb-500')
-- ============================================================
INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was ist TB-500 (Thymosin Beta-4) und wie wird es in der Forschung eingesetzt?',
  'TB-500 ist ein synthetisches Analogon von Thymosin Beta-4, einem natürlich vorkommenden Peptid. In der Forschung wird es auf seine Wirkung auf Aktin-Polymerisation, Zellmigration, Angiogenese und Geweberegeneration untersucht. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='tb-500' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Mechanismen von TB-500 werden in der Forschung untersucht?',
  'Forschungsstudien untersuchen: Regulation der Aktin-Polymerisation über G-Aktin-Sequestration, Stimulation der Zellmigration und -proliferation, Förderung der Angiogenese, anti-inflammatorische Effekte sowie Schutz von Herzmuskelzellen. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='tb-500' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Reinheit hat TB-500 von 369 Research?',
  'TB-500 von 369 Research wird auf >98% Reinheit geprüft und in EU-zertifizierten Labors hergestellt. HPLC-Analyse und Massenspektrometrie für jede Charge. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='tb-500' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What is TB-500 (Thymosin Beta-4) and how is it used in research?',
  'TB-500 is a synthetic analogue of Thymosin Beta-4, a naturally occurring peptide. Research investigates its effects on actin polymerization, cell migration, angiogenesis, and tissue regeneration. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='tb-500' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What mechanisms of TB-500 are studied in research?',
  'Research studies investigate: regulation of actin polymerization via G-actin sequestration, stimulation of cell migration and proliferation, promotion of angiogenesis, anti-inflammatory effects, and protection of cardiomyocytes. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='tb-500' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What purity does TB-500 from 369 Research have?',
  'TB-500 from 369 Research is tested for >98% purity and manufactured in EU-certified laboratories. HPLC analysis and mass spectrometry for each batch. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='tb-500' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

-- ============================================================
-- 6. TESAMORELIN (shopProductId: 'tesamorelin')
-- ============================================================
INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was ist Tesamorelin und welche Rolle spielt es in der GH-Achsen-Forschung?',
  'Tesamorelin ist ein synthetisches Analogon des Wachstumshormon-Releasing-Hormons (GHRH). In der Forschung wird es auf seine Wirkung auf die GH-Achse, IGF-1-Spiegel und viszerales Fettgewebe untersucht. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='tesamorelin' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Mechanismen von Tesamorelin werden in der Forschung untersucht?',
  'Forschungsstudien untersuchen: Stimulation der hypophysären GH-Sekretion, Erhöhung von IGF-1-Spiegeln, Effekte auf viszerales Fettgewebe und Körperzusammensetzung sowie kardiovaskuläre Parameter. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='tesamorelin' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Reinheit hat Tesamorelin von 369 Research?',
  'Tesamorelin von 369 Research wird auf >98% Reinheit geprüft und in EU-zertifizierten Labors hergestellt. HPLC-Analyse für jede Charge. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='tesamorelin' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What is Tesamorelin and what role does it play in GH-axis research?',
  'Tesamorelin is a synthetic analogue of Growth Hormone-Releasing Hormone (GHRH). Research investigates its effects on the GH axis, IGF-1 levels, and visceral adipose tissue. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='tesamorelin' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What mechanisms of Tesamorelin are studied in research?',
  'Research studies investigate: stimulation of pituitary GH secretion, elevation of IGF-1 levels, effects on visceral adipose tissue and body composition, and cardiovascular parameters. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='tesamorelin' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What purity does Tesamorelin from 369 Research have?',
  'Tesamorelin from 369 Research is tested for >98% purity and manufactured in EU-certified laboratories. HPLC analysis for each batch. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='tesamorelin' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

-- ============================================================
-- 7. MOTS-C (shopProductId: 'mots-c')
-- ============================================================
INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was ist MOTS-C und warum ist es in der Longevity-Forschung relevant?',
  'MOTS-C (Mitochondrial Open Reading Frame of the 12S rRNA-c) ist ein mitochondrial kodiertes Peptid. In der Forschung wird es auf seine Wirkung auf metabolische Regulation, Insulinsensitivität und Langlebigkeit untersucht. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='mots-c' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Mechanismen von MOTS-C werden in der Forschung untersucht?',
  'Forschungsstudien untersuchen: Aktivierung des AMPK-Signalwegs, Regulation des Glukosestoffwechsels, Effekte auf mitochondriale Biogenese, Schutz vor altersbedingter metabolischer Dysfunktion sowie Interaktion mit dem Nukleus. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='mots-c' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was unterscheidet MOTS-C von SS-31 in der Mitochondrien-Forschung?',
  'MOTS-C ist ein mitochondrial kodiertes Peptid, das systemisch wirkt und metabolische Signalwege reguliert. SS-31 wirkt direkt auf die innere Mitochondrienmembran und reduziert oxidativen Stress. Beide zeigen komplementäre Mechanismen in der Longevity-Forschung. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='mots-c' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What is MOTS-C and why is it relevant in longevity research?',
  'MOTS-C (Mitochondrial Open Reading Frame of the 12S rRNA-c) is a mitochondrially encoded peptide. Research investigates its effects on metabolic regulation, insulin sensitivity, and longevity. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='mots-c' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What mechanisms of MOTS-C are studied in research?',
  'Research studies investigate: activation of the AMPK signaling pathway, regulation of glucose metabolism, effects on mitochondrial biogenesis, protection against age-related metabolic dysfunction, and nuclear interaction. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='mots-c' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What distinguishes MOTS-C from SS-31 in mitochondrial research?',
  'MOTS-C is a mitochondrially encoded peptide that acts systemically and regulates metabolic signaling pathways. SS-31 acts directly on the inner mitochondrial membrane and reduces oxidative stress. Both show complementary mechanisms in longevity research. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='mots-c' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

-- ============================================================
-- 8. SEMAX (shopProductId: 'semax')
-- ============================================================
INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was ist Semax und warum wird es in der Neurologie-Forschung untersucht?',
  'Semax ist ein synthetisches Heptapeptid, das vom ACTH(4-10)-Fragment abgeleitet ist. In der Neurologie-Forschung wird es auf seine neuroprotektiven, nootropen und BDNF-stimulierenden Eigenschaften untersucht. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='semax' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Mechanismen von Semax werden in der Forschung untersucht?',
  'Forschungsstudien untersuchen: Erhöhung von BDNF (Brain-Derived Neurotrophic Factor), Modulation von Dopamin- und Serotonin-Systemen, neuroprotektive Effekte bei ischämischen Zuständen, Verbesserung kognitiver Parameter sowie Regulation von Immunmediatoren. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='semax' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was unterscheidet Semax von Selank in der Neurologie-Forschung?',
  'Semax wird primär auf kognitive Verbesserung und BDNF-Stimulation untersucht. Selank wird primär auf anxiolytische und immunmodulierende Eigenschaften untersucht. Beide sind synthetische Peptide mit unterschiedlichen Wirkmechanismen. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='semax' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What is Semax and why is it studied in neurology research?',
  'Semax is a synthetic heptapeptide derived from the ACTH(4-10) fragment. Neurology research investigates its neuroprotective, nootropic, and BDNF-stimulating properties. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='semax' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What mechanisms of Semax are studied in research?',
  'Research studies investigate: elevation of BDNF (Brain-Derived Neurotrophic Factor), modulation of dopamine and serotonin systems, neuroprotective effects in ischemic conditions, improvement of cognitive parameters, and regulation of immune mediators. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='semax' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What purity does Semax from 369 Research have?',
  'Semax from 369 Research is tested for >98% purity and manufactured in EU-certified laboratories. HPLC analysis and mass spectrometry for each batch. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='semax' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

-- ============================================================
-- 9. SELANK (shopProductId: 'selank')
-- ============================================================
INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was ist Selank und warum wird es in der Neurologie-Forschung untersucht?',
  'Selank ist ein synthetisches Heptapeptid, das vom Tuftsin-Peptid abgeleitet ist. In der Neurologie-Forschung wird es auf anxiolytische, neuroprotektive und immunmodulierende Eigenschaften untersucht. Es moduliert primär GABAerge und serotoninerge Signalwege. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='selank' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Mechanismen von Selank werden in der Forschung untersucht?',
  'Forschungsstudien untersuchen: Modulation von GABA-A-Rezeptoren, Erhöhung von BDNF und Enkephalin, Regulation von IL-6 und anderen Zytokinen sowie Effekte auf Schlafarchitektur und Stressreaktion. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='selank' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Reinheit hat Selank von 369 Research?',
  'Selank von 369 Research wird auf >98% Reinheit geprüft und in EU-zertifizierten Labors hergestellt. HPLC-Analyse und Massenspektrometrie für jede Charge. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='selank' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What is Selank and why is it studied in neurology research?',
  'Selank is a synthetic heptapeptide derived from the Tuftsin peptide. Neurology research investigates its anxiolytic, neuroprotective, and immunomodulatory properties. It primarily modulates GABAergic and serotonergic signaling pathways. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='selank' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What mechanisms of Selank are studied in research?',
  'Research studies investigate: modulation of GABA-A receptors, elevation of BDNF and enkephalin, regulation of IL-6 and other cytokines, and effects on sleep architecture and stress response. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='selank' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What purity does Selank from 369 Research have?',
  'Selank from 369 Research is tested for >98% purity and manufactured in EU-certified laboratories. HPLC analysis and mass spectrometry for each batch. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='selank' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

-- ============================================================
-- 10. SS-31 / Elamipretide (shopProductId: 'ss-31')
-- ============================================================
INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was ist SS-31 und warum ist es in der Mitochondrien-Forschung relevant?',
  'SS-31 (Elamipretide, auch bekannt als MTP-131) ist ein synthetisches tetrapeptidisches Mitochondrien-targeting-Peptid. In der Forschung wird es auf seine Wirkung auf mitochondriale Funktion, oxidativen Stress und kardioprotektive Mechanismen untersucht. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='ss-31' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Mechanismen von SS-31 werden in der Forschung untersucht?',
  'Forschungsstudien untersuchen: Bindung an Cardiolipin in der inneren Mitochondrienmembran, Reduktion von reaktiven Sauerstoffspezies (ROS), Verbesserung der ATP-Produktion, Schutz vor mitochondrialer Dysfunktion bei Ischämie-Reperfusion sowie Effekte auf zelluläre Seneszenz. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='ss-31' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche klinischen Studien gibt es zu SS-31?',
  'SS-31 (Elamipretide) wurde in Phase-2-Studien bei Herzinsuffizienz und Barth-Syndrom untersucht. Studien wurden im Journal of the American College of Cardiology und anderen Fachzeitschriften publiziert. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='ss-31' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Was unterscheidet SS-31 von MOTS-C in der Longevity-Forschung?',
  'SS-31 wirkt direkt auf die innere Mitochondrienmembran und reduziert oxidativen Stress. MOTS-C ist ein mitochondrial kodiertes Peptid, das systemisch wirkt und metabolische Signalwege reguliert. Beide werden in der Longevity-Forschung untersucht und zeigen komplementäre Mechanismen. Research Use Only.',
  4, 1, 1 FROM articles a WHERE a."shopProductId"='ss-31' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'de', 'Welche Reinheit hat SS-31 von 369 Research?',
  'SS-31 von 369 Research wird auf >98% Reinheit geprüft und in EU-zertifizierten Labors hergestellt. HPLC-Analyse und Massenspektrometrie für jede Charge. Laborreports auf Anfrage. Research Use Only.',
  5, 1, 1 FROM articles a WHERE a."shopProductId"='ss-31' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What is SS-31 and why is it relevant in mitochondrial research?',
  'SS-31 (Elamipretide, also known as MTP-131) is a synthetic tetrapeptide mitochondria-targeting peptide. Research investigates its effects on mitochondrial function, oxidative stress, and cardioprotective mechanisms. Research Use Only.',
  1, 1, 1 FROM articles a WHERE a."shopProductId"='ss-31' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What mechanisms of SS-31 are studied in research?',
  'Research studies investigate: binding to cardiolipin in the inner mitochondrial membrane, reduction of reactive oxygen species (ROS), improvement of ATP production, protection against mitochondrial dysfunction in ischemia-reperfusion, and effects on cellular senescence. Research Use Only.',
  2, 1, 1 FROM articles a WHERE a."shopProductId"='ss-31' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What clinical studies exist on SS-31?',
  'SS-31 (Elamipretide) has been studied in Phase 2 trials for heart failure and Barth syndrome. Studies were published in the Journal of the American College of Cardiology and other journals. Research Use Only.',
  3, 1, 1 FROM articles a WHERE a."shopProductId"='ss-31' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

INSERT INTO article_faq (article_id, lang, question, answer, sort_order, schema_enabled, is_visible)
SELECT a.id, 'en', 'What distinguishes SS-31 from MOTS-C in longevity research?',
  'SS-31 acts directly on the inner mitochondrial membrane and reduces oxidative stress. MOTS-C is a mitochondrially encoded peptide that acts systemically and regulates metabolic signaling pathways. Both are studied in longevity research and show complementary mechanisms. Research Use Only.',
  4, 1, 1 FROM articles a WHERE a."shopProductId"='ss-31' LIMIT 1
ON CONFLICT (article_id, lang, question) DO NOTHING;

-- ============================================================
-- ARTICLE_USE_CASES: Produkt-zu-Use-Case Zuordnungen
-- Portable: alle IDs per Subquery ermittelt
-- ============================================================
-- Retatrutide → fat-loss (primary), metabolic-research
INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 1, 1
FROM articles a, use_cases uc
WHERE a."shopProductId"='3g-triple-g' AND uc.slug='fat-loss'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 2
FROM articles a, use_cases uc
WHERE a."shopProductId"='3g-triple-g' AND uc.slug='metabolic-research'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

-- Tirzepatide → fat-loss, metabolic-research
INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 2
FROM articles a, use_cases uc
WHERE a."shopProductId"='tirzepatide' AND uc.slug='fat-loss'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 1, 1
FROM articles a, use_cases uc
WHERE a."shopProductId"='tirzepatide' AND uc.slug='metabolic-research'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

-- GHK-Cu → beauty (primary), longevity, cosmetic-peptides
INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 1, 1
FROM articles a, use_cases uc
WHERE a."shopProductId"='ghk-cu' AND uc.slug='beauty'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 2
FROM articles a, use_cases uc
WHERE a."shopProductId"='ghk-cu' AND uc.slug='longevity'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 1
FROM articles a, use_cases uc
WHERE a."shopProductId"='ghk-cu' AND uc.slug='cosmetic-peptides'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

-- BPC-157 → recovery (primary), performance
INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 1, 1
FROM articles a, use_cases uc
WHERE a."shopProductId"='bpc-157' AND uc.slug='recovery'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 2
FROM articles a, use_cases uc
WHERE a."shopProductId"='bpc-157' AND uc.slug='performance'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

-- TB-500 → recovery, performance
INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 2
FROM articles a, use_cases uc
WHERE a."shopProductId"='tb-500' AND uc.slug='recovery'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 3
FROM articles a, use_cases uc
WHERE a."shopProductId"='tb-500' AND uc.slug='performance'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

-- Tesamorelin → performance (primary), fat-loss
INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 1, 1
FROM articles a, use_cases uc
WHERE a."shopProductId"='tesamorelin' AND uc.slug='performance'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 3
FROM articles a, use_cases uc
WHERE a."shopProductId"='tesamorelin' AND uc.slug='fat-loss'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

-- MOTS-C → mitochondrial-support (primary), longevity, fat-loss
INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 1, 1
FROM articles a, use_cases uc
WHERE a."shopProductId"='mots-c' AND uc.slug='mitochondrial-support'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 2
FROM articles a, use_cases uc
WHERE a."shopProductId"='mots-c' AND uc.slug='longevity'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

-- Semax → brain (primary), sleep
INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 1, 1
FROM articles a, use_cases uc
WHERE a."shopProductId"='semax' AND uc.slug='brain'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 2
FROM articles a, use_cases uc
WHERE a."shopProductId"='semax' AND uc.slug='sleep'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

-- Selank → sleep (primary), brain
INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 1, 1
FROM articles a, use_cases uc
WHERE a."shopProductId"='selank' AND uc.slug='sleep'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 2
FROM articles a, use_cases uc
WHERE a."shopProductId"='selank' AND uc.slug='brain'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

-- SS-31 → mitochondrial-support (primary), longevity
INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 1, 1
FROM articles a, use_cases uc
WHERE a."shopProductId"='ss-31' AND uc.slug='mitochondrial-support'
ON CONFLICT (article_id, use_case_id) DO NOTHING;

INSERT INTO article_use_cases (article_id, use_case_id, is_primary, sort_order)
SELECT a.id, uc.id, 0, 2
FROM articles a, use_cases uc
WHERE a."shopProductId"='ss-31' AND uc.slug='longevity'
ON CONFLICT (article_id, use_case_id) DO NOTHING;
