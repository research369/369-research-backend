# Partner-Kurzcodes – 26.11.2026

Pakko hat kurze Kunden-Codes ohne BEN-Präfix, die Änderung von Daniels Code und eine professionelle Mitteilung von partnersupport@369research.eu beauftragt. Künftige Partnernummern sollen ebenfalls ohne BEN vergeben werden. Bereits mitgeteilte Partnernummern bleiben unverändert.

## Automatische und manuelle Neuvergabe

Automatische Einladungscodes verwenden den normalisierten ersten Namen (maximal zehn Zeichen) plus `10`, beispielsweise `DANIEL10`. Bei Kollision mit bestehenden, auch historischen Partnercodes, Legacy-Codes, Partnernummern oder aktiven Aktionscodes folgt ein vierstelliger kryptografisch zufälliger Suffix. Automatische Codes sind höchstens 16 Zeichen lang. Neue manuelle Partnercodes werden ebenfalls auf 16 Zeichen ohne `BEN-`-Präfix begrenzt. Bereits gespeicherte längere Codes können weiterhin bearbeitet werden; andere Partner werden nicht automatisch umgestellt oder deaktiviert.

Neue Partnernummern verwenden `P-` plus 16 zufällige Hexzeichen mit unveränderter 64-Bit-Zufallsentropie. Partnernummern und Kunden-Codes autorisieren keine Kontoabfragen. Passwort, aktive Datenbankidentität und Sitzungsprüfung bleiben unverändert.

## Daniels einmalige Datenumstellung

Migration `0038_daniel_short_partner_code.sql` wird ausschließlich im normalen Backend-Deploy-Startpfad ausgeführt, nicht aus einer lesenden API. Es werden keine Admin- oder neuen Operations-Schreibrechte vergeben. Die Migration ist auf Partner ID11, dessen bekannten alten Code, Partnernummer, Namen, aktiven Creatorstatus und unveränderte 10/10-Konditionen festgelegt. Eine neue Codezeile `DANIEL10` wird erstellt; alte Codeidentität1483 bleibt historisch erhalten und wird deaktiviert. Die Partnerprofil-Codeanzeige wird atomar auf den neuen Code gesetzt. Ein Receipt verhindert erneute Ausführung. Kollisionen oder Zustandsabweichungen führen zur vollständigen Rücknahme der Migration, nicht zum Shopausfall. Kurze Lock-/Statement-Timeouts begrenzen Auswirkungen.

Passwort, Partnernummer, Sessionversion, Adresse, Bankkonto, Geldsaldo, Abrechnung, Bestellungen, Bestand, historische Snapshots und Mailhistorie werden nicht verändert. Die Änderungsmail wird erst nach produktiver Bestätigung des neuen Codes separat über Resend mit stabilem Idempotenzschlüssel versendet. Die ursprüngliche Freischaltungs-Mail wird nicht nachträglich umgeschrieben oder erneut versendet.

## Veröffentlichung und Prüfung

Veröffentlichung ausschließlich über bestehendes `research369/369-research-backend` GitHub-main und Railway. Keine interne Manus-Produktivbereitstellung. Releaseprüfung verlangt exakt den veröffentlichten Git-SHA, Railway-GitHub-Deploymentstatus `success`, Backend-Readiness, gültiges `DANIEL10` mit 10%-Creator-/Auszahlungsregeln, ungültigen alten Code und unveränderte Partnernummer/Konto-Konditionen. Neue Einladungscode-Kollisionen, reale Datenmigration, Rollback, Idempotenz und Schutz vor Nebenwirkungen werden auf einer isolierten Unix-Socket-PostgreSQL-Datenbank ohne externe Netzverbindung, API-Schlüssel oder echte E-Mails geprüft.

Die genaue Codeform kann bei Namenskollision einen Suffix enthalten. Es werden keine Testpartner oder Testbestellungen in der Produktivdatenbank angelegt.
