# EPUB Reader Online

A standalone, browser-based **epub reader** focused on fast local reading and TOC-driven navigation.

This project is intentionally simple: one `index.html` file that includes both:
- An SEO landing page
- A full in-browser EPUB reader workflow

After you load an `.epub` file, the UI switches to a split view:
- Left: hierarchical table of contents
- Right: continuous chapter content

Clicking one TOC node renders the current node plus all descendant sections in one reading stream.

## Highlights

- Local-first EPUB processing in browser memory (no backend required for reading flow)
- Parses `container.xml` -> OPF -> manifest/spine
- TOC support:
  - `toc.ncx`
  - EPUB3 nav document
  - spine fallback when TOC is unavailable
- Continuous content rendering in a single scrollable pane
- TOC node selection renders parent + children content together
- Duplicate heading cleanup when chapter title repeats at content start
- Content-pane-only select all (`Cmd/Ctrl + A` / `Ctrl + A` after focusing content area)
- Styled custom scrollbars and reader-focused typography
- SEO landing structure (`header`, `main`, `footer`) with metadata and JSON-LD
- Plausible analytics script integration

## How It Works

1. User drops or selects an EPUB file.
2. JSZip opens the archive in memory.
3. The app resolves `META-INF/container.xml` to locate OPF.
4. OPF parsing builds manifest/spine and discovers TOC source.
5. TOC is parsed from NCX or EPUB3 nav (with fallback logic).
6. Spine chapters are loaded, normalized, and rendered into one content area.
7. Clicking a TOC item re-renders the right pane with that node and all children.

## Tech Stack

- Plain HTML/CSS/JavaScript (no framework)
- [JSZip](https://stuk.github.io/jszip/) (loaded from CDN)
- Browser APIs:
  - `DOMParser`
  - `XMLSerializer`
  - `File` / `ArrayBuffer`
  - Selection and keyboard events

## Project Structure

```text
epub-viewer/
├── index.html
└── README.md
```

## Quick Start

Run as a static site (recommended to avoid local file restrictions and keep behavior consistent):

```bash
cd epub-viewer
pnpm dlx serve .
```

Open the URL printed by `serve` (usually `http://localhost:3000`).

## Usage

1. Open the page.
2. Drag-and-drop an `.epub` file or use the file picker.
3. Wait for parse/render status to complete.
4. Click any TOC item on the left.
5. Read the selected node + descendant content in the right pane.
6. Click inside the content pane, then press `Cmd/Ctrl + A` to select only reader content.

## SEO + Landing Behavior

Before upload, the page shows a full landing layout designed around:
- `epub reader`
- `epub reader online`

After upload, it switches into reader mode and hides the landing screen.

## Analytics

The page includes Plausible:

```html
<script defer data-domain="epub-reader.org" src="https://plausible.yuanzhixiang.com/js/script.js"></script>
```

If you fork this project, replace the domain and script host with your own analytics setup.

## Deployment

This is a static project and can be deployed to:
- GitHub Pages
- Netlify
- Vercel (static)
- Any static file host

## Limitations

- Very large EPUB files may use significant browser memory.
- Some edge-case EPUB files may require additional compatibility handling.
- External references inside EPUB content may not always resolve.

## Roadmap Ideas

- Search within loaded chapters
- Export selected TOC subtree as plain text/markdown
- Better handling for uncommon EPUB packaging edge cases
- Optional dark/light theme switch

## License

No license file is currently included. Add a `LICENSE` file before open-source distribution.
