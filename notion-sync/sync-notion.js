#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.notion') });

const { Client } = require('@notionhq/client');
const fs = require('fs');
const { execSync } = require('child_process');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const ROOT        = path.resolve(__dirname, '..', '..');
const BACKEND_SRC = path.join(ROOT, 'Backend', 'src');
const FRONTEND_APP = path.join(ROOT, 'Frontend', 'app');

// ─────────────────────────────────────────────────────────────
// Block helpers
// ─────────────────────────────────────────────────────────────

const rich = (content, opts = {}) => [{ type: 'text', text: { content: String(content ?? '') }, annotations: opts }];

const h1 = (t)   => ({ object: 'block', type: 'heading_1',  heading_1:  { rich_text: rich(t) } });
const h2 = (t)   => ({ object: 'block', type: 'heading_2',  heading_2:  { rich_text: rich(t) } });
const h3 = (t)   => ({ object: 'block', type: 'heading_3',  heading_3:  { rich_text: rich(t) } });
const p  = (t, bold = false) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(t, { bold }) } });
const divider = () => ({ object: 'block', type: 'divider', divider: {} });
const callout = (t, emoji = 'ℹ️') => ({
  object: 'block', type: 'callout',
  callout: { rich_text: rich(t), icon: { type: 'emoji', emoji } }
});
const bullet = (t) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rich(t) } });
const bullets = (items) => items.map(bullet);

const tableBlock = (headers, rows) => ({
  object: 'block',
  type: 'table',
  table: {
    table_width: headers.length,
    has_column_header: true,
    has_row_header: false,
    children: [
      { object: 'block', type: 'table_row', table_row: { cells: headers.map(h => rich(h, { bold: true })) } },
      ...rows.map(row => ({
        object: 'block',
        type: 'table_row',
        table_row: { cells: row.map(cell => rich(cell ?? '')) }
      }))
    ]
  }
});

const timestamp = () => `Last synced: ${new Date().toUTCString()}`;

// ─────────────────────────────────────────────────────────────
// Notion page update (clear then append in chunks of 100)
// ─────────────────────────────────────────────────────────────

async function replacePageContent(pageId, blocks) {
  const existing = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
  for (const block of existing.results) {
    try { await notion.blocks.delete({ block_id: block.id }); } catch {}
  }
  const CHUNK = 100;
  for (let i = 0; i < blocks.length; i += CHUNK) {
    await notion.blocks.children.append({ block_id: pageId, children: blocks.slice(i, i + CHUNK) });
  }
}

// ─────────────────────────────────────────────────────────────
// Parsers
// ─────────────────────────────────────────────────────────────

function parseAPIs() {
  const src = fs.readFileSync(path.join(BACKEND_SRC, 'server.ts'), 'utf-8');
  const lines = src.split('\n');
  const routes = [];

  const routeRe = /app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/i;

  lines.forEach((line, idx) => {
    const m = line.match(routeRe);
    if (!m) return;

    const method = m[1].toUpperCase();
    const routePath = m[2];

    // Look back up to 4 lines for a comment
    let description = '';
    for (let back = idx - 1; back >= Math.max(0, idx - 4); back--) {
      const commentMatch = lines[back].match(/\/\/\s*(.+)/);
      if (commentMatch) { description = commentMatch[1].trim(); break; }
    }

    // Detect auth middleware
    let auth = 'Public';
    if (line.includes('adminAuthMiddleware'))   auth = 'Admin JWT (12 h)';
    else if (line.includes('sessionVerification')) auth = 'Session + JWT';
    else if (line.includes('authenticateToken'))  auth = 'JWT';

    // Group by prefix
    let group = 'Other';
    if (routePath.includes('/api/admin')) group = 'Admin';
    else if (routePath.startsWith('/auth')) group = 'Auth';
    else if (routePath.startsWith('/business')) group = 'Business';
    else if (routePath.startsWith('/orders')) group = 'Orders';
    else if (routePath.startsWith('/master')) group = 'Master Data';

    routes.push({ method, path: routePath, description, auth, group });
  });

  return routes;
}

function parseModels() {
  const src = fs.readFileSync(path.join(BACKEND_SRC, 'models.ts'), 'utf-8');
  const lines = src.split('\n');
  const models = [];
  let current = null;
  let depth = 0;
  let inSchema = false;

  // Match: export const Business = mongoose.model(...)
  const modelDeclRe = /export\s+const\s+(\w+)\s*=\s*mongoose\.model\(['"`](\w+)/;
  // Match: const XxxSchema = new Schema({
  const schemaDeclRe = /const\s+(\w+Schema)\s*=\s*new\s+Schema/;

  const schemas = {};   // schemaName → fields[]
  let activeSchemeName = null;
  let schemaFields = [];
  let schemaDepth = 0;
  let inSchemaBlock = false;

  lines.forEach(line => {
    const sm = line.match(schemaDeclRe);
    if (sm) {
      activeSchemeName = sm[1];
      schemaFields = [];
      schemaDepth = 0;
      inSchemaBlock = true;
    }

    if (inSchemaBlock) {
      schemaDepth += (line.match(/\{/g) || []).length;
      schemaDepth -= (line.match(/\}/g) || []).length;

      // Extract field name at depth 1 (direct schema fields)
      const fieldRe = /^\s{2,4}(\w+)\s*:/;
      const fm = line.match(fieldRe);
      if (fm) {
        const skip = ['required','default','unique','ref','enum','expires','select','index','get','set'];
        if (!skip.includes(fm[1])) {
          // Extract type
          const typeRe = /type\s*:\s*(\w+)/;
          const tm = line.match(typeRe);
          const typeGuess = tm ? tm[1] : line.includes('String') ? 'String' :
                                        line.includes('Number') ? 'Number' :
                                        line.includes('Boolean') ? 'Boolean' :
                                        line.includes('Date') ? 'Date' : 'Mixed';
          schemaFields.push(`${fm[1]}: ${typeGuess}`);
        }
      }

      if (schemaDepth <= 0 && activeSchemeName) {
        schemas[activeSchemeName] = schemaFields;
        inSchemaBlock = false;
        activeSchemeName = null;
      }
    }

    const mm = line.match(modelDeclRe);
    if (mm) {
      const exportName = mm[1];
      const modelName = mm[2];
      // Find matching schema
      const schemaKey = Object.keys(schemas).find(k => k.toLowerCase().startsWith(modelName.toLowerCase()));
      models.push({ name: modelName, exportName, fields: schemas[schemaKey] || [] });
    }
  });

  return models;
}

function parseTechStack() {
  const apps = [
    { label: 'Frontend (Next.js PWA)',    dir: path.join(ROOT, 'Frontend') },
    { label: 'Admin Dashboard (Next.js)', dir: path.join(ROOT, 'Admin') },
    { label: 'Backend (Express + TypeScript)', dir: path.join(ROOT, 'Backend') },
  ];

  return apps.map(app => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(app.dir, 'package.json'), 'utf-8'));
      return {
        label: app.label,
        version: pkg.version || '—',
        deps: Object.entries(pkg.dependencies || {}).map(([k, v]) => `${k}  ${v}`),
        devDeps: Object.entries(pkg.devDependencies || {}).map(([k, v]) => `${k}  ${v}`),
      };
    } catch {
      return { label: app.label, version: '—', deps: [], devDeps: [] };
    }
  });
}

function parseEnhancements() {
  const repos = [
    { name: 'Frontend', dir: path.join(ROOT, 'Frontend') },
    { name: 'Admin',    dir: path.join(ROOT, 'Admin') },
    { name: 'Backend',  dir: path.join(ROOT, 'Backend') },
  ];

  const all = [];
  for (const repo of repos) {
    try {
      const log = execSync(
        `git -C "${repo.dir}" log --pretty=format:"%h|%ai|%s|%an" -40`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      log.trim().split('\n').filter(Boolean).forEach(line => {
        const [hash, date, subject, author] = line.split('|');
        all.push({ repo: repo.name, hash, date: (date || '').slice(0, 10), subject: subject || '', author: author || '' });
      });
    } catch {}
  }

  return all.sort((a, b) => b.date.localeCompare(a.date));
}

function parseFrontendRoutes() {
  const routes = [];
  function scan(dir, prefix = '') {
    try {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) return;
        const route = prefix + '/' + entry.name;
        if (fs.existsSync(path.join(dir, entry.name, 'page.tsx'))) routes.push(route);
        scan(path.join(dir, entry.name), route);
      });
    } catch {}
  }
  scan(FRONTEND_APP);
  return routes;
}

// ─────────────────────────────────────────────────────────────
// Page syncs
// ─────────────────────────────────────────────────────────────

async function syncAPIReference() {
  const pageId = process.env.NOTION_API_PAGE_ID;
  if (!pageId) return warn('NOTION_API_PAGE_ID', 'API Reference');

  const routes = parseAPIs();
  const groups = ['Admin', 'Auth', 'Business', 'Orders', 'Master Data', 'Other'];
  const toRows = (list) => list.map(r => [r.method, r.path, r.description, r.auth]);

  const blocks = [
    callout(timestamp(), '🔄'),
    divider(),
  ];

  for (const group of groups) {
    const list = routes.filter(r => r.group === group);
    if (!list.length) continue;
    blocks.push(h2(group + ' Routes'));
    blocks.push(tableBlock(['Method', 'Path', 'Description', 'Auth'], toRows(list)));
    blocks.push(divider());
  }

  await replacePageContent(pageId, blocks);
  console.log(`  ✓ API Reference  — ${routes.length} routes`);
}

async function syncDBSchema() {
  const pageId = process.env.NOTION_DB_PAGE_ID;
  if (!pageId) return warn('NOTION_DB_PAGE_ID', 'DB Schema');

  const models = parseModels();
  const blocks = [callout(timestamp(), '🔄'), divider()];

  for (const model of models) {
    blocks.push(h2(model.name));
    blocks.push(...(model.fields.length ? bullets(model.fields) : [p('(no fields parsed)')]));
    blocks.push(divider());
  }

  await replacePageContent(pageId, blocks);
  console.log(`  ✓ DB Schema      — ${models.length} models`);
}

async function syncTechStack() {
  const pageId = process.env.NOTION_TECHSTACK_PAGE_ID;
  if (!pageId) return warn('NOTION_TECHSTACK_PAGE_ID', 'Tech Stack');

  const apps = parseTechStack();
  const blocks = [callout(timestamp(), '🔄'), divider()];

  for (const app of apps) {
    blocks.push(h2(app.label));
    blocks.push(p(`Version: ${app.version}`));
    if (app.deps.length) {
      blocks.push(h3('Dependencies'));
      blocks.push(...bullets(app.deps));
    }
    if (app.devDeps.length) {
      blocks.push(h3('Dev Dependencies'));
      blocks.push(...bullets(app.devDeps));
    }
    blocks.push(divider());
  }

  await replacePageContent(pageId, blocks);
  console.log(`  ✓ Tech Stack     — ${apps.length} apps`);
}

async function syncEnhancements() {
  const pageId = process.env.NOTION_ENHANCEMENTS_PAGE_ID;
  if (!pageId) return warn('NOTION_ENHANCEMENTS_PAGE_ID', 'Enhancements');

  const commits = parseEnhancements();
  const blocks = [
    callout(timestamp(), '🔄'),
    divider(),
    tableBlock(
      ['Date', 'Repo', 'Hash', 'Description', 'Author'],
      commits.map(c => [c.date, c.repo, c.hash, c.subject, c.author])
    )
  ];

  await replacePageContent(pageId, blocks);
  console.log(`  ✓ Enhancements   — ${commits.length} commits`);
}

const PRD_FEATURES = [
  {
    name: 'Order Management',
    route: '/dashboard  &  /dashboard/orders',
    users: 'Business Owner, Staff',
    goal: 'Create, track, and manage laundry orders end-to-end.',
    userStories: [
      'As staff, I can create an order with customer name, phone, items, and due date so customers get a confirmed booking.',
      'As staff, I can update the order status (Created → In Progress → Completed) as the laundry progresses.',
      'As an owner, I can view all orders in history with search and filters to get a complete picture of operations.',
      'As staff, I can cancel an order with a single tap if a customer changes their mind.',
    ],
    acceptance: [
      'Orders display real-time status and are sorted by creation date.',
      'Infinite scroll loads 10 orders per page.',
      'Search is debounced 500 ms; filters include status, service, and date range.',
      'Cancelled and completed orders are visible in history but cannot be re-edited.',
    ],
  },
  {
    name: 'Create Order (Multi-step Form)',
    route: '/dashboard/orders/create',
    users: 'Business Owner, Staff',
    goal: 'Capture all order details — items, pricing, photos, and payment — in a guided two-step flow.',
    userStories: [
      'As staff, I can search and add multiple laundry items with quantity and pricing type (per unit / per kg) so pricing is accurate.',
      'As staff, I can attach photos of garments at drop-off so disputes are avoided at delivery.',
      'As staff, I can set a due date and add notes or extra charges to handle special requests.',
      'As staff, I can mark an order as already paid at creation time to avoid follow-up.',
    ],
    acceptance: [
      'Step 1: customer details + item selection with live search.',
      'Step 2: due date, notes, extra charge with reason, payment toggle, photo upload.',
      'Photo carousel supports multiple images; each can be removed individually.',
      'Form validates phone (10 digits) before allowing submission.',
      'Success/error shown via toast notifications.',
    ],
  },
  {
    name: 'Service Catalogue',
    route: '/dashboard/services',
    users: 'Business Owner (manage), Staff (view)',
    goal: 'Define and manage laundry services with flexible pricing so staff always charge correctly.',
    userStories: [
      'As an owner, I can add a new service with per-unit and per-kg prices so I can price different garment types correctly.',
      'As an owner, I can attach an article type and washing method to a service for clarity.',
      'As staff, I can browse available services when creating an order.',
      'As an owner, I can edit or archive a service; edits apply only to future orders to preserve historical data.',
    ],
    acceptance: [
      'Services displayed in a responsive 3-column grid.',
      'Add/Edit restricted to Owner role.',
      'Archived services are hidden from new orders but preserved in existing order data.',
      'Article and washing method populated from master data.',
    ],
  },
  {
    name: 'Staff Management',
    route: '/dashboard/staff',
    users: 'Business Owner only',
    goal: 'Add and manage staff accounts so team members can access the app under a shared business.',
    userStories: [
      'As an owner, I can add a new staff member with name, phone, and a temporary password.',
      'As an owner, I can edit a staff member\'s name or reset their password at any time.',
      'As an owner, I can deactivate (archive) a staff member to revoke access without deleting their order history.',
    ],
    acceptance: [
      'Staff page visible to Owner role only.',
      'Phone number is immutable after creation.',
      'Archived staff records are moved to ArchivedUser collection; their historical orders remain intact.',
      'Confirmation dialog required before deletion.',
    ],
  },
  {
    name: 'Reports & Excel Export',
    route: '/dashboard/reports',
    users: 'Business Owner only',
    goal: 'Give owners a quick summary of orders and a downloadable report for accounting.',
    userStories: [
      'As an owner, I can select Today / Last 15 Days / Last 1 Month and instantly see order count.',
      'As an owner, I can export the filtered orders to Excel for sharing with my accountant.',
    ],
    acceptance: [
      'Reports page visible to Owner role only.',
      'Excel export includes: S.No., Order ID, Dates, Status, Customer, Items, Extra charges, Total.',
      'Status cells are colour-coded (Created=Yellow, In Progress=Blue, Completed=Green, Cancelled=Red, Paid=Purple).',
      'Export button disabled when no orders match the selected range.',
    ],
  },
  {
    name: 'Invoice / Receipt Printing',
    route: 'Order Modal → Print',
    users: 'Business Owner, Staff',
    goal: 'Generate a printable receipt for the customer at drop-off or pickup.',
    userStories: [
      'As staff, I can open an order and print a receipt listing all items, prices, and total.',
      'As staff, I can hand the printed receipt to the customer as proof of order.',
    ],
    acceptance: [
      'Receipt includes business name, order number, date, items, extra charges, and total.',
      'Print triggered via browser print dialog.',
      'Receipt layout is clean and optimised for A5 / thermal printer.',
    ],
  },
  {
    name: 'WhatsApp Notifications',
    route: 'Triggered from Order Modal',
    users: 'Business Owner, Staff',
    goal: 'Send order updates to customers over WhatsApp without leaving the app.',
    userStories: [
      'As staff, I can send a WhatsApp message to the customer when their order is ready for pickup.',
      'As staff, I get a prompt to notify the customer whenever an order status changes to Completed.',
    ],
    acceptance: [
      'WhatsApp message pre-filled with order number, customer name, and business name.',
      'Notification sent via WhatsApp Business API (Meta).',
      'Prompt appears automatically on status change; staff can dismiss it.',
    ],
  },
  {
    name: 'Multi-language Support',
    route: 'App-wide (Language Switcher)',
    users: 'All users',
    goal: 'Make the app accessible to staff and owners who are more comfortable in Hindi or Kannada.',
    userStories: [
      'As a user, I can switch the app language between English, Hindi, and Kannada from the sidebar.',
      'As a user, my language preference persists across sessions.',
    ],
    acceptance: [
      'Languages supported: English (en), Hindi (hi), Kannada (kn).',
      'All UI labels, buttons, and status names are translated.',
      'Language preference stored in context; persists via localStorage.',
    ],
  },
  {
    name: 'PWA — Installable Mobile App',
    route: 'App-wide',
    users: 'All users',
    goal: 'Allow staff and owners to install the web app on their phone like a native app.',
    userStories: [
      'As a user, I can add the app to my home screen so I can open it without a browser.',
      'As a user, the app loads fast and feels native on my Android or iOS device.',
    ],
    acceptance: [
      'Web app manifest configured with name, icons, theme colour (#4F46E5), and display: standalone.',
      'Service worker enables offline shell.',
      'App passes Lighthouse PWA audit.',
    ],
  },
  {
    name: 'Business Onboarding',
    route: '/dashboard (Welcome Modal)',
    users: 'New Business Owner',
    goal: 'Guide a newly registered business through first steps so they get value quickly.',
    userStories: [
      'As a new owner, I see a welcome modal explaining how to set up services and add staff.',
      'As a new owner, the modal dismisses permanently once I have completed setup.',
    ],
    acceptance: [
      'Welcome modal shown only when onboarding-status API returns incomplete.',
      'Modal dismissed on explicit close and not shown again.',
    ],
  },
  {
    name: 'Admin Panel (Apsara Internal)',
    route: 'localhost:3002 / admin.apsaraclean.com',
    users: 'Apsara Admin team (Tarun, Anshul)',
    goal: 'Let the Apsara team manage all onboarded businesses, track payments, and activate/deactivate accounts.',
    userStories: [
      'As an admin, I can see all businesses with their owner info, status, and payment health at a glance.',
      'As an admin, I can toggle a business active/inactive to pause access if payment lapses.',
      'As an admin, I can record a payment for a business against a billing cycle.',
      'As an admin, I can edit business details (name, address, owner name) without the owner needing to contact support.',
    ],
    acceptance: [
      'Admin login protected by username + password; token expires after 12 h.',
      'Businesses table shows payment badge (Paid / Delayed) based on current billing cycle.',
      'Toggle requires confirmation dialog before taking effect.',
      'Payment records support modes: UPI, Cash, Bank Transfer, NEFT, RTGS, Cheque.',
      'Payment history shown month-wise per business.',
    ],
  },
];

async function syncFeatureList() {
  const pageId = process.env.NOTION_FEATURES_PAGE_ID;
  if (!pageId) return warn('NOTION_FEATURES_PAGE_ID', 'Feature List & PRD');

  const frontendRoutes = parseFrontendRoutes();

  const blocks = [
    callout(timestamp(), '🔄'),
    divider(),
    h2('App Routes'),
    h3('Frontend (Business App)'),
    ...bullets(frontendRoutes.length ? frontendRoutes : ['(no pages found)']),
    h3('Admin Dashboard'),
    ...bullets(['/login', '/dashboard', '/dashboard/businesses/[id]']),
    divider(),
    h1('Feature PRDs'),
    p('Brief product requirement for each feature. Auto-generated from codebase.'),
    divider(),
  ];

  for (const f of PRD_FEATURES) {
    blocks.push(h2(f.name));
    blocks.push(tableBlock(
      ['Field', 'Detail'],
      [
        ['Route / Location', f.route],
        ['Users', f.users],
        ['Goal', f.goal],
      ]
    ));
    blocks.push(h3('User Stories'));
    blocks.push(...bullets(f.userStories));
    blocks.push(h3('Acceptance Criteria'));
    blocks.push(...bullets(f.acceptance));
    blocks.push(divider());
  }

  await replacePageContent(pageId, blocks);
  console.log(`  ✓ Feature List & PRD — ${PRD_FEATURES.length} features`);
}

async function syncDesignSystem() {
  const pageId = process.env.NOTION_DESIGN_SYSTEM_PAGE_ID;
  if (!pageId) return warn('NOTION_DESIGN_SYSTEM_PAGE_ID', 'Design System');

  const blocks = [
    callout(timestamp(), '🔄'),
    divider(),

    // ── Colour Palette ──────────────────────────────────────
    h2('Colour Palette'),
    h3('Business App (Frontend)'),
    tableBlock(
      ['Token', 'Hex Value', 'Usage'],
      [
        ['brand-primary',   '#4F46E5', 'Primary buttons, active states, links'],
        ['brand-secondary', '#4338CA', 'Hover states, secondary actions'],
        ['brand-dark',      '#312E81', 'Dark variant — headings, sidebar emphasis'],
        ['brand-light',     '#f5f5f5', 'Page background, card backgrounds'],
        ['White',           '#FFFFFF', 'Card surfaces, modal backgrounds'],
        ['Foreground',      '#000000', 'Body text'],
      ]
    ),
    h3('Admin Dashboard'),
    tableBlock(
      ['Token', 'Value (oklch)', 'Usage'],
      [
        ['--primary',            'oklch(0.50 0.25 270)', 'Primary actions, focus ring'],
        ['--secondary',          'oklch(0.94 0.04 270)', 'Subtle backgrounds, badges'],
        ['--muted',              'oklch(0.965 0.015 270)', 'Disabled / placeholder areas'],
        ['--destructive',        'oklch(0.60 0.22 25)',  'Delete, deactivate actions'],
        ['--background',         'oklch(0.975 0.012 270)', 'Page background'],
        ['--sidebar',            'oklch(0.17 0.09 270)', 'Deep indigo sidebar'],
        ['--sidebar-accent',     'oklch(0.25 0.08 270)', 'Active nav item background'],
        ['--border',             'oklch(0.90 0.018 270)', 'Card and input borders'],
      ]
    ),
    divider(),

    // ── Typography ──────────────────────────────────────────
    h2('Typography'),
    tableBlock(
      ['Property', 'Value'],
      [
        ['Font Family',     'Inter (Google Fonts)'],
        ['Base size',       '16 px (Tailwind default)'],
        ['Heading scale',   'text-2xl (24 px) → text-sm (14 px) via Tailwind utilities'],
        ['Body text',       'text-sm (14 px) for cards and tables'],
        ['Muted text',      'text-xs (12 px) for labels and metadata'],
        ['Font weight',     'font-semibold for headings, font-medium for labels, font-normal for body'],
      ]
    ),
    divider(),

    // ── Spacing & Border Radius ─────────────────────────────
    h2('Spacing & Border Radius'),
    h3('Frontend App'),
    ...bullets([
      'Cards: rounded-2xl (16 px)',
      'Modals & bottom sheets: rounded-3xl (24 px)',
      'Buttons: rounded-xl (12 px)',
      'Badges / chips: rounded-full',
      'Page padding: px-4 py-4 (mobile-first)',
    ]),
    h3('Admin Dashboard'),
    tableBlock(
      ['Token', 'Value', 'Maps to'],
      [
        ['--radius',    '0.875 rem', 'Base radius (≈ rounded-xl)'],
        ['--radius-sm', 'base × 0.6', '≈ 8.4 px'],
        ['--radius-md', 'base × 0.8', '≈ 11.2 px'],
        ['--radius-lg', 'base × 1.0', '≈ 14 px'],
        ['--radius-xl', 'base × 1.4', '≈ 19.6 px'],
        ['--radius-2xl','base × 1.8', '≈ 25.2 px'],
      ]
    ),
    divider(),

    // ── Component Libraries ─────────────────────────────────
    h2('Component Libraries'),
    tableBlock(
      ['App', 'Library', 'Components Used'],
      [
        ['Frontend',  'Custom (TailwindCSS 4)', 'OrderCard, OrderModal, InvoiceReceipt, WelcomeModal, ConfirmModal, WhatsAppPrompt, Notification, LanguageSwitcher'],
        ['Admin',     'shadcn/ui + Radix UI',   'Table, Dialog, Badge, Button, Input, Switch, Card, Select, Popover, Calendar'],
        ['Both',      'Lucide React',            'Icons throughout — LayoutDashboard, ShoppingCart, Users, ClipboardList, Settings, Loader2, Search, RefreshCw, etc.'],
      ]
    ),
    divider(),

    // ── Icons ───────────────────────────────────────────────
    h2('Icon System'),
    ...bullets([
      'Library: Lucide React (consistent stroke-based icons)',
      'Default size: w-4 h-4 (16 px) for inline / nav icons',
      'Large icons: w-5 h-5 to w-7 h-7 for empty states and section headers',
      'Animated: Loader2 with animate-spin for loading states',
      'All icons inherit text colour from parent (no hardcoded fill)',
    ]),
    divider(),

    // ── UI Patterns ─────────────────────────────────────────
    h2('UI Patterns'),
    tableBlock(
      ['Pattern', 'Implementation'],
      [
        ['Loading state',       'Loader2 spinner (animate-spin) centred in container'],
        ['Empty state',         'Icon in muted rounded box + short message + optional CTA'],
        ['Error state',         'Red text in destructive/8 background pill at top of section'],
        ['Toast notifications', 'Custom Notification component — success (green) / error (red), auto-dismiss'],
        ['Confirmation dialog', 'Modal with Cancel + destructive action button; required before delete/deactivate'],
        ['Infinite scroll',     'IntersectionObserver on sentinel element, 10 items per page'],
        ['Search',              '500 ms debounce on text input, filters local state'],
        ['FAB (mobile)',        'Fixed bottom-right floating action button for primary action (Create Order)'],
        ['Role gating',         'Conditional render based on user.roleId — Owner sees Staff & Reports tabs'],
      ]
    ),
    divider(),

    // ── Responsive Breakpoints ──────────────────────────────
    h2('Responsive Breakpoints'),
    tableBlock(
      ['Breakpoint', 'Width', 'Layout behaviour'],
      [
        ['Mobile (default)', '< 768 px',  'Single column, collapsed sidebar (hamburger), hidden table columns'],
        ['md',               '≥ 768 px',  'Show owner info in tables, 2-column grids'],
        ['lg',               '≥ 1024 px', 'Show address columns, 3-column grids, fixed sidebar'],
      ]
    ),
    divider(),

    // ── Theme Colours (Quick Reference) ────────────────────
    h2('Brand Quick Reference'),
    callout('Primary: #4F46E5  |  Secondary: #4338CA  |  Dark: #312E81  |  Font: Inter', '🎨'),
  ];

  await replacePageContent(pageId, blocks);
  console.log(`  ✓ Design System  — updated`);
}

async function syncArchitecture() {
  const pageId = process.env.NOTION_ARCHITECTURE_PAGE_ID;
  if (!pageId) return warn('NOTION_ARCHITECTURE_PAGE_ID', 'Architecture');

  const blocks = [
    callout(timestamp(), '🔄'),
    divider(),
    h2('System Overview'),
    tableBlock(
      ['Layer', 'Technology', 'Port', 'Deployed At'],
      [
        ['Frontend (PWA)',    'Next.js 15, React 19, TailwindCSS 4', '3000', 'apsara-web.vercel.app'],
        ['Admin Dashboard',  'Next.js 16, shadcn/ui, TailwindCSS 4', '3002', '(internal)'],
        ['Backend API',      'Node.js, Express, TypeScript',          '8000', 'api.apsaraclean.com'],
        ['Database',         'MongoDB (Mongoose ODM)',                 '—',   'MongoDB Atlas'],
        ['File Storage',     'Local / multer',                        '—',   'Server filesystem'],
        ['Auth',             'JWT + express-session',                  '—',   '—'],
      ]
    ),
    divider(),
    h2('Auth Flow'),
    ...bullets([
      'User submits phone + password → POST /auth/login',
      'Server verifies password, signs JWT (no expiry for staff/owner, 12 h for admin)',
      'Token stored in localStorage (admin) or session (business app)',
      'Protected routes validate token via authenticateToken / sessionVerification / adminAuthMiddleware',
    ]),
    divider(),
    h2('Key Design Decisions'),
    ...bullets([
      'Role IDs: 1 = Owner, 2 = Staff (owner sees Staff & Reports tabs)',
      'Status IDs are stored as integers, seeded into AllStatus collection on startup',
      'Services are soft-deleted (isDeleted flag) to preserve historical order data',
      'Staff are archived to ArchivedUser collection on delete',
      'Billing cycle calculated from business.createdAt (monthly rolling)',
      'reCAPTCHA v3 required for login and registration on production',
      'CORS allows: localhost:3002, apsaraclean.com, apsara-web.vercel.app',
    ]),
  ];

  await replacePageContent(pageId, blocks);
  console.log(`  ✓ Architecture   — updated`);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

function warn(envKey, section) {
  console.warn(`  ⚠  ${envKey} not set — skipping ${section}`);
}

async function main() {
  console.log('\n🔄  Syncing Apsara Clean docs to Notion...\n');

  if (!process.env.NOTION_TOKEN) {
    console.error('❌  NOTION_TOKEN is not set. Copy scripts/.env.notion.example → scripts/.env.notion and fill it in.');
    process.exit(1);
  }

  const results = await Promise.allSettled([
    syncAPIReference(),
    syncDBSchema(),
    syncTechStack(),
    syncEnhancements(),
    syncFeatureList(),
    syncArchitecture(),
    syncDesignSystem(),
  ]);

  results.forEach(r => {
    if (r.status === 'rejected') console.error('  ✗ Error:', r.reason?.message || r.reason);
  });

  console.log('\n✅  Done\n');
}

main();
