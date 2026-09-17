require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.VIEWER_PORT || 3000;
const HOST = process.env.VIEWER_HOST || 'localhost';

// ============================================================================
// CSV PARSING
// ============================================================================

function parseCSV(csvContent) {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return []; // No data

  const headers = lines[0].split(',').map(h => h.trim());
  const tickets = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const fields = [];
    let currentField = '';
    let insideQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];

      if (char === '"') {
        if (insideQuotes && line[j + 1] === '"') {
          // Escaped quote
          currentField += '"';
          j++;
        } else {
          // Toggle quote state
          insideQuotes = !insideQuotes;
        }
      } else if (char === ',' && !insideQuotes) {
        // Field separator
        fields.push(currentField.trim());
        currentField = '';
      } else {
        currentField += char;
      }
    }
    fields.push(currentField.trim());

    // Remove surrounding quotes from fields
    const cleanedFields = fields.map(f => {
      if (f.startsWith('"') && f.endsWith('"')) {
        return f.slice(1, -1);
      }
      return f;
    });

    const ticket = {};
    headers.forEach((header, idx) => {
      ticket[header.toLowerCase()] = cleanedFields[idx] || '';
    });

    tickets.push(ticket);
  }

  return tickets;
}

// ============================================================================
// API ROUTES
// ============================================================================

app.get('/api/tickets', (req, res) => {
  try {
    const csvPath = path.join(process.cwd(), 'tickets.csv');

    if (!fs.existsSync(csvPath)) {
      return res.json([]);
    }

    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const tickets = parseCSV(csvContent);

    res.json(tickets);
  } catch (err) {
    console.error('Error reading tickets:', err.message);
    res.status(500).json({ error: 'Failed to read tickets' });
  }
});

// ============================================================================
// FRONTEND
// ============================================================================

const htmlPage = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Ticket Viewer</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #f5f7fa;
      color: #1e293b;
      line-height: 1.5;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }

    header {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: white;
      padding: 32px 24px;
      border-radius: 8px;
      margin-bottom: 32px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }

    header h1 {
      font-size: 28px;
      margin-bottom: 8px;
      font-weight: 600;
    }

    header p {
      opacity: 0.9;
      font-size: 14px;
    }

    .controls {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 16px;
      margin-bottom: 24px;
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    @media (max-width: 768px) {
      .controls {
        grid-template-columns: 1fr;
      }
    }

    .control-group {
      display: flex;
      flex-direction: column;
    }

    label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #64748b;
      margin-bottom: 8px;
    }

    input, select {
      padding: 10px 12px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      font-size: 14px;
      transition: border-color 0.2s;
    }

    input:focus, select:focus {
      outline: none;
      border-color: #0284c7;
      box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.1);
    }

    .stats {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
      font-size: 14px;
      color: #64748b;
    }

    .stat-item {
      background: white;
      padding: 12px 16px;
      border-radius: 6px;
      border-left: 3px solid #0284c7;
    }

    .table-wrapper {
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead {
      background: #f8fafc;
      border-bottom: 2px solid #e2e8f0;
    }

    th {
      padding: 16px;
      text-align: left;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #475569;
      cursor: pointer;
      user-select: none;
      position: relative;
      white-space: nowrap;
    }

    th:hover {
      background: #f1f5f9;
    }

    th .sort-indicator {
      margin-left: 6px;
      opacity: 0.5;
    }

    th.sorted .sort-indicator {
      opacity: 1;
    }

    td {
      padding: 16px;
      border-bottom: 1px solid #e2e8f0;
      font-size: 14px;
    }

    tbody tr:hover {
      background: #f8fafc;
    }

    tbody tr:last-child td {
      border-bottom: none;
    }

    .timestamp {
      color: #64748b;
      font-size: 13px;
    }

    .group {
      font-weight: 500;
      color: #0284c7;
    }

    .raiser {
      color: #7c3aed;
      font-weight: 500;
    }

    .issue {
      font-weight: 500;
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .summary {
      color: #64748b;
      font-size: 13px;
      max-width: 250px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .no-data {
      text-align: center;
      padding: 48px 24px;
      color: #94a3b8;
    }

    .no-data svg {
      width: 64px;
      height: 64px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    .loading {
      text-align: center;
      padding: 48px 24px;
      color: #64748b;
    }

    .spinner {
      display: inline-block;
      width: 24px;
      height: 24px;
      border: 3px solid #e2e8f0;
      border-top-color: #0284c7;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      background: #e0f2fe;
      color: #0369a1;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📋 WhatsApp Ticket Viewer</h1>
      <p>View and manage all raised support tickets</p>
    </header>

    <div class="controls">
      <div class="control-group">
        <label for="search">Search</label>
        <input type="text" id="search" placeholder="Search across all fields...">
      </div>
      <div class="control-group">
        <label for="filterGroup">Group</label>
        <select id="filterGroup">
          <option value="">All Groups</option>
        </select>
      </div>
      <div class="control-group">
        <label for="filterRaiser">Raiser</label>
        <select id="filterRaiser">
          <option value="">All Raisers</option>
        </select>
      </div>
    </div>

    <div class="stats">
      <div class="stat-item">Total Tickets: <strong id="totalCount">0</strong></div>
      <div class="stat-item">Displayed: <strong id="displayCount">0</strong></div>
    </div>

    <div class="table-wrapper" id="tableContainer">
      <div class="loading">
        <div class="spinner"></div>
        <p style="margin-top: 16px;">Loading tickets...</p>
      </div>
    </div>
  </div>

  <script>
    let allTickets = [];
    let filteredTickets = [];

    async function loadTickets() {
      try {
        const response = await fetch('/api/tickets');
        if (!response.ok) throw new Error('Failed to fetch tickets');
        allTickets = await response.json();
        populateFilters();
        renderTable();
        updateStats();
      } catch (err) {
        console.error('Error loading tickets:', err);
        document.getElementById('tableContainer').innerHTML =
          '<div class="no-data"><p>Failed to load tickets</p></div>';
      }
    }

    function populateFilters() {
      const groups = [...new Set(allTickets.map(t => t.group))].filter(Boolean).sort();
      const raisers = [...new Set(allTickets.map(t => t.raiser))].filter(Boolean).sort();

      const groupSelect = document.getElementById('filterGroup');
      const raiserSelect = document.getElementById('filterRaiser');

      groups.forEach(group => {
        const option = document.createElement('option');
        option.value = group;
        option.textContent = group;
        groupSelect.appendChild(option);
      });

      raisers.forEach(raiser => {
        const option = document.createElement('option');
        option.value = raiser;
        option.textContent = raiser;
        raiserSelect.appendChild(option);
      });
    }

    function applyFilters() {
      const searchTerm = document.getElementById('search').value.toLowerCase();
      const groupFilter = document.getElementById('filterGroup').value;
      const raiserFilter = document.getElementById('filterRaiser').value;

      filteredTickets = allTickets.filter(ticket => {
        const matchesSearch = !searchTerm || Object.values(ticket).some(val =>
          String(val).toLowerCase().includes(searchTerm)
        );
        const matchesGroup = !groupFilter || ticket.group === groupFilter;
        const matchesRaiser = !raiserFilter || ticket.raiser === raiserFilter;

        return matchesSearch && matchesGroup && matchesRaiser;
      });

      renderTable();
      updateStats();
    }

    function updateStats() {
      document.getElementById('totalCount').textContent = allTickets.length;
      document.getElementById('displayCount').textContent = filteredTickets.length;
    }

    function renderTable() {
      if (filteredTickets.length === 0) {
        document.getElementById('tableContainer').innerHTML =
          '<div class="no-data"><p>No tickets found</p></div>';
        return;
      }

      const html = \`
        <table>
          <thead>
            <tr>
              <th class="sortable" data-column="timestamp">Timestamp <span class="sort-indicator">⇅</span></th>
              <th class="sortable" data-column="group">Group <span class="sort-indicator">⇅</span></th>
              <th class="sortable" data-column="raiser">Raiser <span class="sort-indicator">⇅</span></th>
              <th class="sortable" data-column="issue">Issue <span class="sort-indicator">⇅</span></th>
              <th class="sortable" data-column="notes">Notes <span class="sort-indicator">⇅</span></th>
              <th class="sortable" data-column="summary">Summary <span class="sort-indicator">⇅</span></th>
            </tr>
          </thead>
          <tbody>
            \${filteredTickets.map(ticket => \`
              <tr>
                <td class="timestamp">\${ticket.timestamp}</td>
                <td class="group"><span class="badge">\${ticket.group}</span></td>
                <td class="raiser">\${ticket.raiser}</td>
                <td class="issue" title="\${ticket.issue}">\${ticket.issue}</td>
                <td>\${ticket.notes || '—'}</td>
                <td class="summary" title="\${ticket.summary}">\${ticket.summary || '—'}</td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      \`;

      document.getElementById('tableContainer').innerHTML = html;

      // Add sort functionality
      document.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => sortTable(th.dataset.column));
      });
    }

    function sortTable(column) {
      const isAscending = filteredTickets.sorted === column && !filteredTickets.ascending;

      filteredTickets.sort((a, b) => {
        const aVal = String(a[column]).toLowerCase();
        const bVal = String(b[column]).toLowerCase();

        return isAscending ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
      });

      filteredTickets.sorted = column;
      filteredTickets.ascending = !isAscending;
      renderTable();
    }

    // Event listeners
    document.getElementById('search').addEventListener('input', applyFilters);
    document.getElementById('filterGroup').addEventListener('change', applyFilters);
    document.getElementById('filterRaiser').addEventListener('change', applyFilters);

    // Load tickets on page load
    loadTickets();
  </script>
</body>
</html>
`;

app.get('/', (req, res) => {
  res.send(htmlPage);
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, HOST, () => {
  console.log(`\n📊 Ticket Viewer running at http://${HOST}:${PORT}`);
  console.log(`Press Ctrl+C to stop\n`);
});
