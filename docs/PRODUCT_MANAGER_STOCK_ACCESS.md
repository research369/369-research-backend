# Bestandszugriff für Product Manager

Seit dieser Erweiterung erlaubt `article.adjustStock` die Rollen `admin`, `packing` und `product_manager`. Dafür wird ausschließlich eine separate `stockProcedure` verwendet. Die generellen Admin- und Packing-Verfahren und die Nutzerrollen bleiben unverändert. Die Erweiterung erteilt keine zusätzlichen Kunden-, Bestell-, Rechnungs- oder Zahlungsrechte.

## Bestehende API

`POST /api/trpc/article.adjustStock` mit dem bestehenden Bearer-Sessiontoken und JSON:

```json
{
  "json": {
    "id": 42,
    "change": 20,
    "type": "korrektur",
    "reason": "Expliziter Auftrag: Cagrilintide 10 mg auf 20 Stück; Referenz <eindeutige Referenz>",
    "expectedStock": 0
  }
}
```

`change` ist eine relative Lagerbewegung, kein Zielbestand. Für einen Zielbestand zuerst `article.get` lesen, ID/SKU/Stärke prüfen und `change = Zielbestand - gelesener Bestand` berechnen. `expectedStock` ist optional für Rückwärtskompatibilität, soll bei API-Einzelkorrekturen aber immer mitgeschickt werden. Bei verändertem Bestand wird nicht geschrieben. Auch zwischen Vorabprüfung und Transaktion schützt der kanonische Service mit Zeilensperre und Bestands-/SKU-Vergleich.

Die vier bestehenden Bewegungstypen bleiben gültig: `wareneingang`, `verkauf`, `korrektur`, `retoure`. `verkauf` bezeichnet hier nur eine Lagerbewegung und legt keine Bestellung oder Finanzbuchung an. Bestehende WaWi-Aufrufe ohne `expectedStock` bleiben gültig.

## Protokoll und Verifikation

Lagerbestand und `stock_history` werden weiterhin zusammen in einer Transaktion gespeichert. Als Bearbeiter wird Name, ersatzweise Benutzername, dokumentiert. `article.history` kann mit `articleId` und `limit` abgefragt werden. Nach dem Schreiben sowohl `article.get` als auch die öffentliche Variante in `article.shopProducts` und den passenden Historyeintrag prüfen.

Bei Timeout oder unklarer Antwort niemals die Mutation blind wiederholen: über die eindeutige Grundreferenz die Historie und den neuen Bestand prüfen. Diese Route bietet keine allgemeine Request-Idempotenz; `expectedStock` ist ein Bestandsvergleich, keine Datensatzversion.

Es werden weder Kundennachrichten ausgelöst noch Aufträge geändert. Die bisherige Benachrichtigung bei negativer manueller Packing-Buchung bleibt unverändert. Product-Manager-Bewegungen sind in der Lagerhistorie protokolliert; das generische Admin-Journal bleibt auf Adminaktionen begrenzt.

## Tests

`tsx --test server/stockAccess.test.ts` prüft erlaubte und abgelehnte Rollen, unveränderte Admin-/Packing-Grenzen, Validierung der echten Bestandsroute, ihre exklusive Berechtigungsverwendung sowie den kanonischen Bestandsservice einschließlich Konflikten, Grenzen und Bearbeiterhistorie. Die Tests führen keine Produktionsbuchung aus.
