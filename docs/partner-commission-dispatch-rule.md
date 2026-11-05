# Freigabe von Partnerprovisionen

Verbindliche Nutzerregel vom 16.10.2026: Eine Partnerprovision darf erst gutgeschrieben werden, wenn die Bestellung bezahlt **und** verschickt ist.

Die zentrale Buchungsfunktion liest und sperrt die gespeicherte Bestellung. Sie verlangt einen Zahlungszeitpunkt (`paid_at`), einen Versandzeitpunkt (`shipped_at`) und den Status `versendet` oder `zugestellt`. Offen, nur bezahlt, gepackt, abgeholt, storniert oder ein Versandstatus ohne Versandzeitpunkt lösen keine neue Provision aus. Eine nicht gespeicherte Bestellung wird abgewiesen. Der beim Checkout gespeicherte erwartete Provisionsbetrag ist keine Guthabenbuchung.

Die Regel gilt auch für individuell freigegebene Beträge und den administrativen Kompatibilitätsendpunkt. Wiederholte und gleichzeitige Aufrufe bleiben durch Bestell-/Partnersperren und die Prüfung vorhandener normaler Provisionsbuchungen idempotent. Bestehende Buchungen werden durch diesen Wechsel weder rückwirkend korrigiert noch neu gebucht. Die Zahlungsbedingungen des getrennten KWK-Systems werden nicht geändert.

Die automatische Partnerprüfung meldet bei einer noch nicht verschickten bezahlten Bestellung keine fehlende Provision. Ihre Zweiminutenfrist beginnt beim späteren der beiden Bestätigungszeitpunkte. Bestehende Buchungen mit fehlender Versandbestätigung bleiben prüfbedürftig; fehlende historische Regeln werden nicht durch heutige Regeln ersetzt.

Regression: getrennte PostgreSQL-Testdatenbank, fehlende Bestellung, acht gesperrte Status-/Bestätigungskombinationen ohne Finanzänderung, erfolgreiche bezahlte und versendete Bestellung, zwei gleichzeitige Buchungsversuche mit genau einer Gutschrift, Wiederholung und individueller Provisionssatz. Produktionsabnahme ausschließlich lesend, ohne Testbestellung oder Zahlung.
