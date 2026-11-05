# Guardian: geschützte Rabattregeln

Vorbereitet, nicht aktiviert. GET `/api/guardian/discounts` verwendet den bestehenden
separaten Guardian-Leseschlüssel und zusätzlich `GUARDIAN_DISCOUNT_READ_ENABLED=true`.
Dieser zusätzliche Leseumfang benötigt die gemeinsame Produktionsfreigabe.
Keine Änderung an Bestell-, Rabatt- oder Kundendaten, keine Migration.

Der feste Snapshot enthält Aktionscodes und einzelne Creator-/Partner-/Eigennutzercodes
mit Rabattwert, Aktivität, Programmregel, Mindestwert, Produkt- und Versandbindung.
Inaktive/abgelaufene/ausgeschöpfte Codes bleiben als negative Testfälle enthalten.
Keine Namen, E-Mails, Adressen, Guthaben, Provisionen, Bestellungen oder Freitexte
verlassen die Projektion. Datenbanktransaktion READ ONLY, Zeitlimit5s, maximal500Codes;
bei unvollständigen, doppelten oder ungültigen Regeln503 statt Teilabdeckung.

Der Browserprüfer in BEDO Control liest diesen Snapshot vor jedem Prüflauf. Die
öffentlichen Codevalidierungen dürfen nur lesend aufgerufen werden. Nutzungszähler
und Bestellungen werden nie angelegt. Kundenhistorie und Eigennutzeridentität sind
nicht Bestandteil dieser Verbindung und müssen im Prüfer als nicht geprüft erscheinen.

Rollout: Backend-PR mit CI prüfen/freigeben, bereitstellen und Flag aktivieren;
401 ohne separaten Schlüssel,503 ohne Flag,200 mit vollständigem Snapshot bestätigen.
Dann freigegebenen Guardian-Dienst mit read-only Schlüsseldatei verbinden. Keine
Schlüssel in Browser-JavaScript oder Git. Rückfall: Flag entfernen; Guardian zeigt
Codeprüfung offen, bisheriger Inventurleser bleibt verfügbar.
