# Partneranträge: kontogebundener Lesezugriff

Freigabe: Pakko, 26.11.2026 um 11:14:39 Uhr Europe/Berlin: Der bestehende Zugang darf Partneranträge lesen.

## Geltungsbereich

`partnerInvitation.pending` und die neue Abfrage `partnerInvitation.byDay({date: "YYYY-MM-DD"})` verwenden ausschließlich die bestehende kontogebundene `operations_read`-Berechtigung. Sie ist an Benutzer-ID 2, Benutzername `product_manager`, aktuelle Rolle `product_manager` und einen tatsächlich vorhandenen, nicht widerrufenen Datenbank-Grant gebunden. Andere Produktmanager erhalten dadurch keinen Zugriff. Der bisherige Administratorzugriff bleibt unverändert.

`byDay` umfasst offene, freigegebene und abgelehnte Anträge des angegebenen Berliner Kalendertags. Die Zeitgrenzen verwenden `Europe/Berlin` und berücksichtigen Sommerzeit. Explizit ausgegebene Felder: ID, Name, E-Mail, Telefonnummer, Firma, Status, Erstellungszeit, Prüfzeit und verknüpfte Partner-ID. Passwörter, Passwort-Hashes, Recovery-Hashes, Einrichtungslinks und Bankdaten werden nicht ausgegeben.

## Ausdrücklich nicht freigegeben

Keine Änderung an `partnerInvitation.approve`, `partnerInvitation.reject`, bestehenden Partner-Schreibrechten, Rollen, Konten, Maildispatch oder Auszahlung. Es werden keine Partner freigeschaltet, abgelehnt oder angeschrieben. Kein neues allgemeines Administratorrecht, keine rollenweite Freigabe und keine neue Datenbankmigration.

Der Zugriff kann durch Widerruf des vorhandenen `operations_read`-Grants oder durch Änderung der Kontoidentität sofort gesperrt werden; der Grant wird bei jeder Anfrage erneut geprüft.
