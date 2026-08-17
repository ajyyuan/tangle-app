# Tangle MVP Plan

## Foundation

- Create a minimal Next.js + TypeScript app with `@xyflow/react`.
- Keep the data model small: tasks, dependency edges, ordering, and graph positions.
- Persist the complete model in `localStorage`, with the internship example seeded on first use.

## Core experience

- Build a shared task store so List and Graph always edit the same data.
- Implement the List view as a fast inline checklist with keyboard-first creation/editing, completion, deletion, and drag reordering.
- Implement the Graph view with compact custom task nodes, draggable connections, edge deletion, inline editing/completion, pan/zoom, and persisted positions.
- Reject self-links, duplicate links, and dependency cycles with a quiet, temporary message.
- Derive completed, available, and blocked presentation from dependency state rather than storing extra status.

## Polish and verification

- Add a restrained responsive visual system with careful focus, hover, empty, and reduced-motion states.
- Verify persistence, task editing/completion/deletion, list ordering, node movement, connection creation/deletion, and cycle prevention.
- Run lint/build checks and exercise the running app in a browser, fixing visual or interaction issues found.
