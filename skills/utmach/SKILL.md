---
name: utmach
description: Guía de uso del servidor MCP utmach (EVEA Moodle + SIUTMACH) para estudiantes de la Universidad Técnica de Machala. Úsala cuando el usuario pregunte por cursos, tareas, notas, materiales, horarios, asistencias o avance de malla en la UTMACH.
---

# Guía de agente para `utmach-mcp`

Tienes acceso al servidor MCP **`utmach`** (100% solo lectura) conectado a **EVEA Moodle UTMACH** y **SIUTMACH**.

## Reglas clave de la UTMACH

1. **Sistema de calificación oficial (SIUTMACH):**
   - Cada parcial se compone de **70% evaluación de proceso** (componentes N1..N12) + **30% examen final**, sobre 10 puntos por parcial.
   - Las notas oficiales válidas viven en **SIUTMACH** (`siutmach_get_grades`); **EVEA Moodle** (`evea_get_grades`) puede tener ponderaciones parciales o no reflejar el total consolidado.
2. **Reglamento de asistencias:**
   - El límite máximo de inasistencias es el **15%** de las horas totales de la asignatura (`maxAbsentPercent`).
   - Usa `siutmach_get_attendance` (por defecto filtra al periodo actual) para avisar cuántas horas de falta le quedan al estudiante (`remainingAbsentHours`).
3. **Instancias EVEA disponibles (`site`):**
   - `presencial` *(default)*, `cec`, `enlinea`, `ir`, `nivelacion`. Solo pasa `site` si el usuario menciona otra instancia (ej. CEC).

## Qué herramienta elegir

- *"¿Qué tengo hoy/mañana?"* o resumen general → **`utmach_daily_briefing`**.
- *"¿Qué tareas me faltan?"* → **`evea_list_tasks`** (resalta tareas próximas, `isHiddenFromTimeline: true` y cualquier `dateConflict.hasConflict: true`).
- *"¿De qué trata esta tarea?"* → **`evea_get_task_detail`**.
- *"Resúmeme el sílabo / PDF / diapositivas"* → primero **`evea_list_materials`**, luego **`evea_read_material`** (usa `startPage`/`endPage` si el documento es largo; si `isScannedPdf: true`, informa al usuario y comparte `localPath`).
- *"¿Cómo voy en notas?"* → **`siutmach_get_grades`** (`scope: "current"` para parciales del semestre actual, `"history"` para avance de malla) o **`utmach_compare_grades`** para cruzar con EVEA.
- *"¿Hay algo nuevo en el aula?"* → **`evea_check_changes`**.

## Manejo de sesiones expiradas

El servidor MCP nunca abre ventanas de navegador por sí mismo ni almacena contraseñas. Si una herramienta responde que la sesión expiró o falta autenticación:

- **EVEA Moodle:** indica al usuario que ejecute en su terminal:
  ```bash
  utmach login
  # o para otra instancia: utmach login --site cec
  ```
- **SIUTMACH:** indica al usuario que ejecute en su terminal:
  ```bash
  utmach siutmach login
  ```

Luego vuelve a ejecutar la herramienta con `refresh: true` cuando el usuario confirme que ya inició sesión.
