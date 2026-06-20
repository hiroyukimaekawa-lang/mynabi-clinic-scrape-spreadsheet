const LIST_PATH_RE = /^\/article_list(\/|$)/i;
const ARTICLE_PATH_RE = /^\/article\/[a-z0-9_-]+\/?$/i;
const DAY_LABELS = ["月", "火", "水", "木", "金", "土", "日", "祝"];

const PREFECTURES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
    "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
    "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"
];

const state = { running: false, rows: [] };

const ui = {
    startUrls: document.getElementById("startUrls"),
    delay: document.getElementById("delay"),
    startBtn: document.getElementById("startBtn"),
    csvBtn: document.getElementById("csvBtn"),
    status: document.getElementById("status"),
    log: document.getElementById("log"),
};

function setStatus(text) { ui.status.textContent = text; }

function log(message) {
    const now = new Date();
    const stamp = now.toLocaleTimeString("ja-JP", { hour12: false });
    ui.log.textContent += `[${stamp}] ${message}\n`;
    ui.log.scrollTop = ui.log.scrollHeight;
}

function sleep(sec) {
    if (!sec || sec <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}

function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").replace(/^[\s\-]+|[\s\-]+$/g, "").trim();
}

function errText(err) {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    if (err.message) return err.message;
    return String(err);
}

async function fetchHtml(url) {
    const res = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
}

function valueByThLabel(root, label) {
    const rows = Array.from(root.querySelectorAll("tr"));
    for (const tr of rows) {
        const th = tr.querySelector("th");
        const td = tr.querySelector("td");
        if (!th || !td) continue;
        if (cleanText(th.textContent).includes(label)) return cleanText(td.textContent);
    }
    return "";
}

function normalizeScheduleMark(text) {
    const t = cleanText(text);
    if (!t) return "";
    if (/[●○◯〇]/.test(t)) return "●";
    if (/[✕✖×]/.test(t)) return "×";
    if (/[休]/.test(t)) return "休";
    if (/[\-ー－―–—]/.test(t)) return "-";
    return t;
}

function inferMark(cell) {
    const attrs = [
        cell.getAttribute("aria-label") || "", cell.getAttribute("title") || "",
        cell.getAttribute("data-status") || "", cell.getAttribute("class") || "", cell.innerHTML || "",
    ].join(" ");
    if (/(circle|maru|open|available|on)/i.test(attrs)) return "●";
    if (/(cross|close|ng|xmark)/i.test(attrs)) return "×";
    if (/(dash|bar|hyphen|off|holiday|rest)/i.test(attrs)) return "-";
    return "";
}

function parseConsultationHoursFromTable(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 2) return "";
    const headCells = Array.from(rows[0].querySelectorAll("th,td"));
    if (headCells.length < 2) return "";
    const headerText = cleanText(rows[0].textContent);
    const hasHoursHeader = headerText.includes("診療時間") || headCells.some((c) => cleanText(c.textContent) === "診療時間");
    if (!hasHoursHeader) return "";
    let dayCols = headCells.slice(1).map((c) => cleanText(c.textContent));
    if (!dayCols.length || dayCols.every((d) => !d)) dayCols = DAY_LABELS.slice(0, headCells.length - 1);
    const lines = [];
    for (const row of rows.slice(1)) {
        const cells = Array.from(row.querySelectorAll("th,td"));
        if (cells.length < 2) continue;
        const timeText = cleanText(cells[0].textContent);
        if (!timeText || timeText.includes("診療時間")) continue;
        const parts = [];
        for (let i = 1; i < cells.length; i++) {
            const day = dayCols[i - 1] || DAY_LABELS[i - 1] || `col${i}`;
            let mark = normalizeScheduleMark(cells[i].textContent);
            if (!mark) mark = inferMark(cells[i]);
            if (!mark) mark = "-";
            parts.push(`${day}:${mark}`);
        }
        lines.push(`${timeText} ${parts.join(" ")}`);
    }
    return lines.join(" | ");
}

function extractConsultationHours(block) {
    const tables = Array.from(block.querySelectorAll("table"));
    for (const table of tables) {
        const parsed = parseConsultationHoursFromTable(table);
        if (parsed) return parsed;
    }
    return valueByThLabel(block, "診療時間");
}

function extractFacilityName(block) {
    const selectors = [".post-clinic-block_title", ".post-clinic-block_name", ".post-clinic-name", ".m-clinic-card_title", "h2", "h3", "h4"];
    for (const sel of selectors) {
        const text = cleanText(block.querySelector(sel)?.textContent || "");
        if (text) return text;
    }
    return cleanText(block.querySelector("strong")?.textContent || "");
}

function extractPhone(block) {
    const labelPhone = valueByThLabel(block, "電話番号");
    if (labelPhone) return labelPhone;
    const m = cleanText(block.textContent).match(/0\d{1,4}-\d{1,4}-\d{3,4}/);
    return m ? m[0] : "";
}

function extractPrefecture(doc, title) {
    for (const pref of PREFECTURES) { if (title.includes(pref)) return pref; }
    for (const a of Array.from(doc.querySelectorAll("a"))) {
        const txt = cleanText(a.textContent);
        if (PREFECTURES.includes(txt)) return txt;
    }
    const bodyText = doc.body?.textContent || "";
    for (const pref of PREFECTURES) { if (bodyText.includes(`「${pref}・`)) return pref; }
    return "";
}

function extractArea(title) {
    const m = title.match(/(?:】|\]|\[|【|\s|^)([^】\]\[【\s]+?[市区郡町村])/);
    if (m && m[1].length <= 15) {
        let area = m[1].replace(/^[^\w\u3040-\u30FF\u4E00-\u9FFF]+/, "");
        for (const pref of PREFECTURES) {
            if (area.startsWith(pref) && area !== pref) area = area.substring(pref.length);
        }
        return area;
    }
    return "";
}

function extractHeadingTitle(doc) {
    const el = doc.querySelector("h1.heading__title") || doc.querySelector(".heading__title") || doc.querySelector("[class*='heading__title']") || doc.querySelector("h1");
    return cleanText(el?.textContent || "");
}

function extractClinicsFromArticleHtml(html, articleUrl, sheetName = "") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const articleTitle = cleanText(doc.querySelector(".m-article_header .m-article_header_title, .m-article_header_title, h1")?.textContent || "");
    const headingTitle = extractHeadingTitle(doc);
    const blocks = Array.from(doc.querySelectorAll(".post-clinic-block"));
    const rows = [];

    blocks.forEach((block) => {
        const hours = extractConsultationHours(block);
        const timeParts = hours ? hours.split("|").map(s => s.trim()) : [];
        const parseTime = (part, pos) => {
            if (!part) return "";
            const m = part.match(/(\d{1,2}:\d{2})[〜～\-~](\d{1,2}:\d{2})/);
            return m ? m[pos] : "";
        };

        let closedDays = valueByThLabel(block, "休診日");
        if (!closedDays) {
            const closedSet = new Set();
            for (const dm of hours.matchAll(/([月火水木金土日祝]):休/g)) closedSet.add(dm[1]);
            closedDays = [...closedSet].join("、");
        }
        if (!closedDays) {
            const m = cleanText(block.textContent).match(/休診日[：:]\s*([^\n。]{1,50})/);
            if (m) closedDays = m[1].trim();
        }

        const openSet = new Set();
        for (const m of hours.matchAll(/([月火水木金土日祝]):[●○◯〇]/g)) openSet.add(m[1]);
        const openDays = [...openSet].join(",");

        rows.push({
            シート記事名: sheetName,
            記事タイトル: headingTitle,
            診療科目: extractPrefecture(doc, articleTitle) ? extractArea(articleTitle) : "",
            電話番号: extractPhone(block),
            医院名: extractFacilityName(block),
            午前始: parseTime(timeParts[0], 1),
            午前終: parseTime(timeParts[0], 2),
            午後始: parseTime(timeParts[1], 1),
            午後終: parseTime(timeParts[1], 2),
            営業曜日: openDays,
            休診日: closedDays,
        });
    });
    return rows;
}

function encodeCsvField(value) {
    const text = value == null ? "" : String(value);
    if (text.includes('"') || text.includes(",") || text.includes("\n")) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function toCsv(rows) {
    const headers = ["シート記事名", "記事タイトル", "診療科目", "電話番号", "医院名", "午前始", "午前終", "午後始", "午後終", "営業曜日", "休診日"];
    const lines = [headers.join(",")];
    rows.forEach((row) => lines.push(headers.map((h) => encodeCsvField(row[h] ?? "")).join(",")));
    return `\uFEFF${lines.join("\n")}`;
}

function downloadText(filename, text, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    chrome.downloads.download({ url: objectUrl, filename, saveAs: true }, () => setTimeout(() => URL.revokeObjectURL(objectUrl), 1000));
}

async function runScrape() {
    if (state.running) return;

    const lines = ui.startUrls.value.trim().split('\n').filter(l => l.trim() !== "");
    if (lines.length === 0) { alert("データを入力してください。"); return; }

    const inputData = [];
    for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 2) {
            inputData.push({ sheetName: parts[0].trim(), url: parts[1].trim() });
        } else {
            inputData.push({ sheetName: "", url: parts[0].trim() });
        }
    }

    const delaySec = Number(ui.delay.value) || 1.0;
    state.running = true;
    state.rows = [];
    ui.startBtn.disabled = true;
    ui.csvBtn.disabled = true;
    ui.log.textContent = "";
    log(`スクレイピング開始（対象: ${inputData.length}件）`);

    try {
        const rows = [];
        for (let i = 0; i < inputData.length; i++) {
            const { sheetName, url } = inputData[i];
            setStatus(`解析中: ${i + 1}/${inputData.length}`);
            log(`----------------------------------------\n[${i + 1}/${inputData.length}] URL: ${url}`);
            if (sheetName) log(`シート記事名: ${sheetName}`);

            try {
                new URL(url);
                const html = await fetchHtml(url);
                const extracted = extractClinicsFromArticleHtml(html, url, sheetName);
                extracted.forEach((r) => rows.push(r));
                log(`抽出成功: ${extracted.length}件`);
            } catch (err) {
                log(`WARN 取得失敗: ${url} (${errText(err)})`);
            }
            if (i < inputData.length - 1) await sleep(delaySec);
        }

        state.rows = rows;
        setStatus(`完了: 合計 ${state.rows.length}件`);
        log(`========================================\n全処理完了: ${state.rows.length}件`);
        ui.csvBtn.disabled = state.rows.length === 0;
    } catch (err) {
        setStatus("エラーで停止しました");
        log(`ERROR: ${errText(err)}`);
    } finally {
        state.running = false;
        ui.startBtn.disabled = false;
    }
}

ui.startBtn.addEventListener("click", runScrape);
ui.csvBtn.addEventListener("click", () => {
    if (!state.rows.length) return;
    downloadText(`mynavi_clinics_spreadsheet_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(state.rows), "text/csv;charset=utf-8");
});