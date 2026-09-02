# PF2e Chat Filter

PF2e Chat Filter ist ein clientseitiger Chat-Filter für **Foundry Virtual Tabletop v14** und **Pathfinder 2e**. Das Modul blendet Nachrichten im sichtbaren Chat nach einem oder mehreren Nicht-GM-Spielern ein oder aus, ohne ChatMessage-Dokumente zu verändern oder zu löschen.

## Features

- Filterung nach einem oder mehreren Spielern (ODER-Verknüpfung)
- Anzeige aller Nicht-GM-Accounts, einschließlich Offline-Spielern
- Online-Spieler zuerst, danach alphabetisch sortiert
- Optionaler Einbezug relevanter Actor-, Token-, Whisper-, Target-, Origin- und PF2e-Flag-Bezüge
- Lokale, je Client gespeicherte Auswahl
- Automatisches Filtern neu gerenderter Nachrichten
- Wiederherstellung nach Chat- und Sidebar-Renders
- Foundry-nahe Gestaltung und deutsch/englische Lokalisierung

## Installation

### Über die Manifest-URL

In Foundrys Modulverwaltung **Modul installieren** wählen und folgende URL eintragen:

```text
https://github.com/USERNAME/pf2e-chat-filter/releases/latest/download/module.json
```

`USERNAME` muss vor einer Veröffentlichung im Manifest und in dieser README durch den tatsächlichen GitHub-Benutzernamen oder die Organisation ersetzt werden.

### Manuelle Installation

1. `pf2e-chat-filter.zip` aus einem Release herunterladen.
2. Den Inhalt als Verzeichnis `pf2e-chat-filter` unter Foundrys `Data/modules/` entpacken.
3. Foundry neu starten und das Modul in der PF2e-Welt aktivieren.

## Benutzung

Der Filter-Button mit dem Trichter-Symbol erscheint in der Chat-Steuerleiste. Ein Klick öffnet das Auswahlmenü. **Alle Spieler** setzt den Filter zurück und zeigt wieder jede Nachricht.

### Mehrfachauswahl

Mehrere Spielernamen können nacheinander aktiviert werden; das Menü bleibt dabei geöffnet. Eine Nachricht bleibt sichtbar, sobald sie zu mindestens einem ausgewählten Spieler passt.

### Online- und Offline-Spieler

Alle Nicht-GM-Benutzer werden angeboten. Ein gefüllter Kreis kennzeichnet Online-, ein leerer Kreis Offline-Spieler. Online-Spieler stehen am Anfang der Liste.

### Bezug einbeziehen

Bei aktivierter Option zählen neben selbst erzeugten Nachrichten auch Nachrichten, die einen ausgewählten Spieler betreffen. Dazu wertet das Modul Autor/User, Whisper-Empfänger, Speaker-Actor und -Token sowie rekursiv PF2e-Flags aus. Die Identität umfasst Actors, auf die der Spieler OWNER-Zugriff besitzt, seinen zugewiesenen Charakter und deren Tokens auf allen Szenen.

Die Flag-Suche ist absichtlich generisch und tiefenbegrenzt. Sie kann damit Target-, Origin-, Schadens- und weitere PF2e-Referenzen finden, ohne von einem einzelnen PF2e-Nachrichtenschema abhängig zu sein.

## Kompatibilität

- Foundry Virtual Tabletop v14
- Pathfinder 2e (PF2e)
- Moderne Browser mit ES-Module-Unterstützung

Das Modul verwendet bewusst keine zusätzliche Foundry-v13-Kompatibilität.

## Datenschutz und lokale Filterung

Die Auswahl wird als Foundry-Client-Setting nur im jeweiligen Browser gespeichert. Das Modul sendet nichts an andere Clients und ändert oder löscht keine ChatMessages. Es verändert ausschließlich die Sichtbarkeit bereits gerenderter Chat-Elemente im lokalen DOM.

## Bekannte Einschränkungen

- Die Bezugserkennung kann nur Referenzen erkennen, die eine User-, Actor- oder Token-Kennung in den von der ChatMessage bereitgestellten Daten enthalten.
- Sehr ungewöhnliche PF2e-Flags unterhalb der Rekursionstiefe sechs werden nicht durchsucht.
- Die Anchor-Suche orientiert sich an der Chat-Steuerleiste von Foundry v14. Größere UI-Änderungen in späteren Foundry-Versionen können Anpassungen erfordern.
- Die Release-URLs enthalten bis zur Projektveröffentlichung den Platzhalter `USERNAME`.

## Änderungen gegenüber dem Makro

Die Filtersemantik des ursprünglichen `chat-filter-macro.js` bleibt erhalten. Notwendige Moduländerungen sind: gekapselter Klassen-State statt `window`-Schlüsseln, zentrale Lifecycle-Hooks, Client-Settings, ausgelagertes CSS und Lokalisierung, Cache-Invalidierung bei Dokumentänderungen sowie ein zyklensicherer Schutz der weiterhin tiefenbegrenzten Flag-Suche. Das Makro selbst bleibt als Referenz unverändert.

## Entwicklung

Das Modul benötigt keinen Build-Schritt. Die Dateien im Repository entsprechen direkt der installierbaren Modulstruktur. Syntax und Manifest können beispielsweise so geprüft werden:

```bash
node --check scripts/chat-filter.js
python -m json.tool module.json >/dev/null
```

## Release-Prozess

1. Änderungen committen und einen semantischen Tag wie `v1.0.0` setzen.
2. Den Tag zu GitHub pushen.
3. Die GitHub Action übernimmt die Version aus dem Tag, aktualisiert `module.json`, baut das ZIP ohne zusätzliche Root-Ebene und veröffentlicht Manifest und ZIP als Release Assets.

Vor dem ersten Release müssen `USERNAME` in `module.json`, `README.md` und gegebenenfalls die Repository-Einstellungen angepasst werden.
