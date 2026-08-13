# Kundenhistorie, Dublettenprüfung und WhatsApp-Composer

## Zweck

Diese Erweiterung ist vollständig additiv. Sie zeigt verbindliche Kundenhistorie im Kunden- und Bestellkontext, erkennt mögliche Dubletten täglich und manuell und erlaubt WhatsApp-Vorlagen sowie freie Nachrichten. Sie verändert nie automatisiert Kunden, Bestellungen, Bestände, Zahlungen oder Versandstatus.

## Konfiguration

| Schlüssel in `shop_settings` | Bedeutung | Standard |
|---|---|---|
| `customer_integrity_enabled` | Aktiviert die tägliche Prüfung | `true` |
| `customer_integrity_schedule_hour` | Lokale Ausführungsstunde, 0–23 | `3` |
| `customer_integrity_last_run` | Technischer Nachweis der letzten Prüfung | Wird durch den Service geschrieben |

Die API `customerIntegrity.updateConfig` aktualisiert diese Werte. Die tägliche Prüfung erzeugt ausschließlich `duplicate_check_runs` und `duplicate_findings`.

## Regeln für Prüffälle

| Entität | Regel | Sicherheit |
|---|---|---|
| Kunde | gleiche echte E-Mail-Adresse | 100 % Prüffall |
| Kunde | gleiche Telefonnummer | 96 % Prüffall |
| Kunde | gleicher Name und gleiche Lieferadresse | 82 % Prüffall |
| Bestellung | gleiche echte E-Mail, gleicher Warenkorb, gleicher Betrag innerhalb von 24 Stunden | 90 % Prüffall |

Platzhalter-E-Mail-Adressen sind ausgeschlossen. Ein Prüffall kann nur als geprüft oder kein Duplikat markiert werden. Eine Zusammenführung bleibt ein separater, späterer, expliziter Workflow.

## Verbindlicher Umsatz

Kundenhistorie zählt ausschließlich die Status `bezahlt`, `gepackt`, `versendet` und `zugestellt`. Offene und stornierte Bestellungen ändern den angezeigten Kundenumsatz nicht.

## WhatsApp ohne API

Der Composer nutzt die bestehende konfigurierbare Auswahl zwischen WhatsApp Web und App. Beim Öffnen wird ein Kommunikationsnachweis als `vorbereitet/geöffnet` abgelegt. Erst der separate Klick `Als gesendet markieren` protokolliert eine manuell bestätigte Sendung. Ohne WhatsApp-API wird nie behauptet, eine Nachricht sei zugestellt.

## Wichtige Dateien

| Bereich | Datei |
|---|---|
| Dublettenregeln und Scheduler | `server/customerIntegrityService.ts` |
| Prüfungs- und Konfigurations-API | `server/customerIntegrityRouter.ts` |
| Datenbankmigration | `server/customerIntegritySchema.ts` |
| Kunden-/Bestellkontext | `client/src/components/CustomerContextPanel.tsx` |
| Prüfwartereschlange | `client/src/components/DuplicateReviewPanel.tsx` |

## Abnahme

1. Bestell- und Kundendatensatz zeigen die gleiche Zahl der verbindlichen Bestellungen und den gleichen Umsatz.
2. Manuelle Prüfung erzeugt ausschließlich Prüffälle und ändert keine Stamm- oder Bestelldaten.
3. Täglicher Lauf wird einmal je Kalendertag zum konfigurierten Zeitpunkt protokolliert.
4. WhatsApp Web/App öffnet mit der gewählten Vorlage oder freiem Text.
5. Die Kommunikationsakte unterscheidet vorbereitet/geöffnet und manuell als gesendet markiert.
