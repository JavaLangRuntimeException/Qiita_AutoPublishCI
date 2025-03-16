const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const axios = require('axios');
const { execSync } = require('child_process');

const QIITA_TOKEN = process.env.QIITA_TOKEN;
if (!QIITA_TOKEN) {
    console.error("Error: QIITA_TOKEN が設定されていません。");
    process.exit(1);
}

/**
 * ファイルを Qiita API 経由で更新または新規投稿する
 */
async function syncFile(filePath) {
    try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const parsed = matter(fileContent);
        const data = parsed.data || {};
        const content = parsed.content || "";

        // Qiita API では、タグ情報は { name: "...", versions: [] } の形式で送る必要があるので変換する
        const formattedTags = (data.tags || []).map(tag => {
            return (typeof tag === 'string') ? { name: tag, versions: [] } : tag;
        });

        // API リクエスト用のペイロード作成
        const payload = {
            body: content,
            private: false,
            tags: formattedTags,
            title: data.title || "Untitled"
        };

        let response;
        if (!data.id || data.id === null) {
            console.log(`新規投稿: ${filePath}`);
            // POST リクエスト → 新規記事作成
            response = await axios.post("https://qiita.com/api/v2/items", payload, {
                headers: {
                    "Authorization": `Bearer ${QIITA_TOKEN}`,
                    "Content-Type": "application/json"
                }
            });
            // 返却された記事情報でフロントマターを更新（id, created_at, updated_at）
            data.id = response.data.id;
            data.created_at = response.data.created_at;
            data.updated_at = response.data.updated_at;
        } else {
            console.log(`更新 (PATCH): ${filePath} (id: ${data.id})`);
            // PATCH リクエスト → 既存記事の更新
            const url = `https://qiita.com/api/v2/items/${data.id}`;
            response = await axios.patch(url, payload, {
                headers: {
                    "Authorization": `Bearer ${QIITA_TOKEN}`,
                    "Content-Type": "application/json"
                }
            });
            // 更新された情報 (updated_at) を反映
            data.updated_at = response.data.updated_at;
        }

        // 更新後のフロントマターと本文でファイルを書き換え
        const newContent = matter.stringify(content, data);
        fs.writeFileSync(filePath, newContent, 'utf8');
        console.log(`更新完了: ${filePath}`);
    } catch (error) {
        if (error.response && error.response.data) {
            console.error(`Error processing ${filePath}:`, error.response.data);
        } else {
            console.error(`Error processing ${filePath}:`, error.message);
        }
        // エラーが発生したら強制終了して workflow を失敗させる
        process.exit(1);
    }
}

/**
 * main ブランチとの差分で変更があった ./public 配下の Markdown ファイルのみ対象にする
 */
async function processChangedFiles() {
    let diffOutput = "";
    try {
        // origin/main との比較で変更があったファイル一覧を取得
        diffOutput = execSync("git diff --name-only origin/main -- ./public").toString();
    } catch (error) {
        console.error("Error fetching changed files:", error.message);
        process.exit(1);
    }
    const changedFiles = diffOutput
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== "" && line.endsWith('.md'));

    if (changedFiles.length === 0) {
        console.log("更新対象の Markdown ファイルはありません。");
        return;
    }

    for (const file of changedFiles) {
        // パスが相対パスの場合、スクリプトの実行ディレクトリを考慮して調整
        const fullPath = path.resolve(file);
        await syncFile(fullPath);
    }
}

// 未捕捉例外および Promise の未処理拒否も検知してプロセスを終了する
process.on('uncaughtException', error => {
    console.error("Uncaught Exception:", error);
    process.exit(1);
});
process.on('unhandledRejection', error => {
    console.error("Unhandled Rejection:", error);
    process.exit(1);
});

(async () => {
    try {
        await processChangedFiles();
        console.log("Qiita 同期処理が完了しました。");
    } catch (ex) {
        console.error("処理中にエラーが発生しました:", ex);
        process.exit(1);
    }
})();