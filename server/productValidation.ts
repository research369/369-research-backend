import { requiresResearchOnlyValidation } from "./productValidationPolicy.js";
export function validateProductData(a: any, seoRow: any, merchantRow: any, translationRow: any) {
    const article = [a], seo = [seoRow], merchant = [merchantRow], deTranslation = [translationRow];
    const issues: string[] = [];
    const warnings: string[] = [];
    // === PFLICHTFELDER (blockieren Speicherung) ===
    if (!article[0].name)
        issues.push("Produktname fehlt");
    if (!article[0].sku)
        issues.push("SKU fehlt");
    if (!article[0].shopProductId)
        issues.push("shopProductId fehlt");
    if (!article[0].sellingPrice || Number(article[0].sellingPrice) <= 0)
        issues.push("Verkaufspreis fehlt oder 0");
    if (article[0].stock === null || article[0].stock === undefined || article[0].stock < 0)
        issues.push("Bestand darf nicht negativ sein");
    if (!article[0].mockupImageUrl)
        issues.push("Hauptbild fehlt (mockupImageUrl)");
    if (!seo[0])
        issues.push("SEO-Eintrag fehlt (kein Slug vorhanden)");
    if (seo[0] && !seo[0].slug)
        issues.push("Slug fehlt");
    if (!seo[0]?.seoTitle)
        issues.push("SEO Title fehlt (max. 60 Zeichen)");
    if (!seo[0]?.seoDescription)
        issues.push("Meta Description fehlt (max. 155 Zeichen)");
    // === PREISLOGIK ===
    const sp = Number(article[0].sellingPrice ?? 0);
    const sale = article[0].salePrice ? Number(article[0].salePrice) : null;
    if (sale !== null && sale >= sp)
        issues.push(`Sale Price (${sale} €) muss kleiner als Verkaufspreis (${sp} €) sein`);
    // === SEO LÄNGEN-CHECKS ===
    if (seo[0]?.seoTitle && seo[0].seoTitle.length > 60)
        warnings.push(`SEO Title zu lang: ${seo[0].seoTitle.length} Zeichen (max. 60)`);
    if (seo[0]?.seoDescription && seo[0].seoDescription.length > 155)
        warnings.push(`Meta Description zu lang: ${seo[0].seoDescription.length} Zeichen (max. 155)`);
    // === CANONICAL URL ===
    if (seo[0]?.canonical && !seo[0].canonical.startsWith("https://www.369research.eu")) {
        warnings.push(`Canonical URL sollte mit https://www.369research.eu beginnen`);
    }
    // === MERCHANT CHECKS ===
    if (!merchant[0])
        warnings.push("Merchant-Eintrag fehlt");
    if (!deTranslation[0]?.merchantTitle)
        warnings.push("Merchant Title fehlt (DE)");
    if (!deTranslation[0]?.merchantDescription)
        warnings.push("Merchant Description fehlt (DE)");
    if (!merchant[0]?.availability)
        warnings.push("Verfügbarkeit nicht gesetzt (Standard: in_stock)");
    if (!merchant[0]?.productType)
        warnings.push("Product Type fehlt (Google Shopping)");
    if (!merchant[0]?.googleProductCategory)
        warnings.push("Google Product Category fehlt");
    // === KATEGORIE ===
    const cats = article[0].categories as unknown[];
    if (!article[0].category && (!cats || cats.length === 0)) {
        warnings.push("Keine Kategorie gesetzt");
    }
    const requiresResearchOnlyMetadata = requiresResearchOnlyValidation({
        category: article[0].category,
        categories: cats,
    });
    // === COMPLIANCE CHECKS ===
    const values = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(values).join(' ') : value && typeof value === 'object' ? Object.values(value).map(values).join(' ') : '';
    const descText = values(article[0].description).toLowerCase();
    const shortDesc = (article[0].shortDescription ?? "").toLowerCase();
    const allText = descText + " " + shortDesc;
    const forbiddenPhrases = ["dosierung", "einnahme", "nehmen sie", "täglich einnehmen", "heilt", "behandelt", "therapie", "heilmittel"];
    for (const phrase of forbiddenPhrases) {
        if (allText.includes(phrase)) {
            warnings.push(`Möglicher Human-Use Hinweis: "${phrase}" – bitte prüfen`);
        }
    }
    const hasResearchNote = allText.includes("research use only") || allText.includes("forschungszwecke") || allText.includes("not for human use");
    if (requiresResearchOnlyMetadata && !hasResearchNote)
        warnings.push("Research Use Only Hinweis fehlt im Produkttext");
    // === OPTIONALE EMPFEHLUNGEN ===
    if (requiresResearchOnlyMetadata && !article[0].casNumber)
        warnings.push("CAS-Nummer fehlt (empfohlen für Peptide)");
    if (!article[0].shortDescription)
        warnings.push("Kurzbeschreibung fehlt");
    if (requiresResearchOnlyMetadata && !article[0].purity)
        warnings.push("Reinheitsangabe fehlt");
    const totalChecks = 18;
    const score = Math.max(0, Math.round(((totalChecks - issues.length * 2 - warnings.length * 0.5) / totalChecks) * 100));
    return {
        shopProductId: article[0].shopProductId,
        name: article[0].name,
        sku: article[0].sku,
        sellingPrice: article[0].sellingPrice,
        salePrice: article[0].salePrice,
        stock: article[0].stock,
        slug: seo[0]?.slug ?? null,
        seoTitle: seo[0]?.seoTitle ?? null,
        seoDescription: seo[0]?.seoDescription ?? null,
        merchantTitle: deTranslation[0]?.merchantTitle ?? null,
        merchantDescription: deTranslation[0]?.merchantDescription ?? null,
        hasImage: !!article[0].mockupImageUrl,
        hasResearchNote,
        isValid: issues.length === 0,
        issues,
        warnings,
        score,
    };
}
