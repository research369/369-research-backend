# Bot-freigegebene Angebote

Nur der bestehende authentifizierte Lese-Endpunkt POST /api/pepgpt-read/offers erhält den optionalen promotion.mode bot_approved. Der Order-Vertrag bleibt none/explicit_code; keine Bestellung wird aktiviert. Das Default ohne Modus bleibt none.

Positive Freigabe wird separat in shop_settings unter pepgpt_bot_promo_policy gespeichert, ohne neue Spalten oder Veränderung der bestehenden Shop-Promos. Format:

    {"version":1,"enabled":true,"codes":[{"code":"VOM_BETREIBER_FREIGEGEBEN","bot_auto_apply":true,"bot_priority":0}]}

Keine Codefreigabe aus einer Beschreibung, KI-Vermutung oder Negativliste ableiten. Ohne Liste, bei enabled:false, fehlerhaftem Format oder doppeltem Code bleibt die Auswahl leer. Die Liste enthält nur Codes, die der Betreiber ausdrücklich öffentlich für den Bot freigegeben hat. Keine Testcodes in Produktion hinzufügen. Verwaltung ausschließlich über den bestehenden geschützten WaWi-Einstellungsweg bzw. die autorisierte interne Administration. Rücknahme: enabled:false oder betreffenden bot_auto_apply:false setzen. Keine Nutzungscounter schreiben.

Zusätzlich werden bestehende persönliche Zuordnungen, Follow-up-Codes, Erinnerungs-Codes und Beschreibungen für persönliche/individuelle Bestellungen bereits im SQL ausgeschlossen. Aktive Gültigkeit, Start-/Endzeit, Nutzungslimit, Mindestbestellwert, Produktbindung, kundenspezifische Limits, Versand, Globalrabatt-/Stacking-Regeln und tatsächlicher Preisvorteil bleiben verbindlich. Pro Variante maximal ein Code: kleinster finaler Endpreis, bei Gleichstand höhere bot_priority, dann Code alphabetisch. Nicht freigegebene Codes werden nicht offengelegt. Expliziter Kundencode wird weiterhin exakt geprüft und hat Vorrang vor automatischer Auswahl.

Antwort enthält regulären Angebotspreis und separat die serverseitig berechnete Promo-Summe samt Versand/Endpreis. bot_approved:true kennzeichnet nur tatsächlich über diese positive Liste ausgewählte Codes. Warenbestand wird nicht reserviert. Vor späterem Senden prüft der Bot erneut; geänderte Werte benötigen neue Telegram-Freigabe.

Isolierte Tests verwenden synthetische Codes. Keine Order-, Kunden-, Mail- oder Bestandsmutation in diesem Modul. Der Shop-Checkout und normale Promo-Verwaltung bleiben unverändert.
