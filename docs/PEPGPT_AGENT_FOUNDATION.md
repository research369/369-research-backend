# PepGPT Agent Foundation

## Ziel

PepGPT wird als echter, tenant-gerouteter LLM-Agent betrieben. Die Foundation selbst enthält keine Produkt-, Dosierungs- oder Sales-Entscheidungslogik.

## Request-Pfad

`Channel Adapter -> agent.run -> AgentRegistry -> PepGptAgent -> OpenAI Responses API -> AgentResponse -> Channel Adapter`

Für den Tenant `369-research` wird aktuell `PepGptAgent` verwendet.

## Wissensquellen

Die fachliche Wissensbasis bleibt außerhalb des Codes in den zwei zentral gepflegten Google-Drive-Dateien:

- `PEP_BEHAVIOR.md`
- `PEP_PRODUCT_KNOWLEDGE.md`

Bevorzugter Modus ist privater Google-Drive-Zugriff über einen Service Account. Die beiden Docs bleiben damit privat und müssen nur mit der Service-Account-Adresse als Leser geteilt werden. Der Server exportiert sie als `text/plain` und cached sie standardmäßig 300 Sekunden.

Wenn eine Quelle fehlt, nicht lesbar oder leer ist, wird die Agent-Ausführung abgebrochen. Es gibt keinen lokalen Fake-/Fallback-Agenten.

Erforderliche Runtime-Variablen im bevorzugten privaten Drive-Modus:

- `OPENAI_API_KEY`
- `GOOGLE_DRIVE_CLIENT_EMAIL`
- `GOOGLE_DRIVE_PRIVATE_KEY`
- `PEPGPT_BEHAVIOR_DOCUMENT_ID`
- `PEPGPT_PRODUCT_KNOWLEDGE_DOCUMENT_ID`

Alternativ kann für nicht-private Quellen jeweils eine serverseitig abrufbare Text-URL gesetzt werden:

- `PEPGPT_BEHAVIOR_URL`
- `PEPGPT_PRODUCT_KNOWLEDGE_URL`

Optionale Variablen:

- `PEPGPT_MODEL` (Default: `gpt-5.6-sol`)
- `PEPGPT_INTERNAL_KEY` (fällt derzeit auf `WAWI_INTERNAL_KEY` zurück)
- `PEPGPT_MAX_OUTPUT_TOKENS` (Default: `1800`)
- `PEPGPT_KNOWLEDGE_CACHE_SECONDS` (Default: `300`)
- `OPENAI_API_BASE_URL` (Default: `https://api.openai.com/v1`)

## Logging

Eine echte Agent-Ausführung erzeugt mindestens folgende strukturierte Events:

- `agent.request.sent`
- `agent.response.received`

Dadurch darf in Logs/Quality-Auswertungen nur dann von einer PepGPT-Antwort gesprochen werden, wenn tatsächlich ein Response-Event vom Provider vorliegt.

## Commerce

PEP-Dateien sind keine Quelle für veränderliche Commerce-Daten. Preise, Bestand, Varianten, Rabatte, Versand und Lieferbarkeit müssen später als Live-Kontext/Tools angebunden werden. Der Agent darf diese Daten nicht erfinden.

## Rollout

1. Branch/PR typechecken.
2. Google-Service-Account anlegen und ausschließlich Lesezugriff auf die beiden PepGPT-Docs geben.
3. Dokument-IDs, Service-Account-Credentials und OpenAI-Key in einer nicht-produktiven/Preview-Umgebung konfigurieren.
4. `agent.run` mit Testfällen gegen die echten Drive-Dateien testen.
5. Quality-Suite auf Entscheidungsqualität statt Keyword-Matching umstellen.
6. Live-Shop-Kontext/Tools für veränderliche Commerce-Daten anbinden.
7. Erst danach WhatsApp-Adapter auf `agent.run` umschalten.
8. Kein Merge/Deploy ohne explizite Freigabe.
