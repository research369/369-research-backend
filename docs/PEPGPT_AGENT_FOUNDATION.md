# PepGPT Agent Foundation

## Ziel

PepGPT wird als echter, tenant-gerouteter LLM-Agent betrieben. Die Foundation selbst enthält keine Produkt-, Dosierungs- oder Sales-Entscheidungslogik.

## Request-Pfad

`Channel Adapter -> agent.run -> AgentRegistry -> PepGptAgent -> OpenAI Responses API -> AgentResponse -> Channel Adapter`

Für den Tenant `369-research` wird aktuell `PepGptAgent` verwendet.

## Wissensquellen

Die fachliche Wissensbasis bleibt außerhalb des Codes in den zwei zentral gepflegten Dateien:

- `PEP_BEHAVIOR.md`
- `PEP_PRODUCT_KNOWLEDGE.md`

Der Server lädt beide Quellen über konfigurierbare Text-URLs und cached sie standardmäßig 300 Sekunden. Wenn eine Quelle fehlt oder leer ist, wird die Agent-Ausführung abgebrochen. Es gibt keinen lokalen Fake-/Fallback-Agenten.

Erforderliche Runtime-Variablen:

- `OPENAI_API_KEY`
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
2. Google-Drive-Dokumente über serverseitig abrufbare Text-URLs bereitstellen.
3. OpenAI-Key und PepGPT-Variablen in einer nicht-produktiven/Preview-Umgebung konfigurieren.
4. `agent.run` mit Testfällen gegen die echten Drive-Dateien testen.
5. Quality-Suite auf Entscheidungsqualität statt Keyword-Matching umstellen.
6. Erst danach WhatsApp-Adapter auf `agent.run` umschalten.
7. Kein Merge/Deploy ohne explizite Freigabe.
