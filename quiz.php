<?php
// quiz.php — single entry point and API for the Pub Quiz
// Requirements:
// - URL: quiz.php?team=<8-hex>
// - Commands via `cmd` param: status (GET), guess (POST), round (GET, admin only)
// - Otherwise serves base HTML (quiz.html)

// ======== CONFIG ========
$DB_HOST = getenv('PGHOST') ?: 'localhost';
$DB_PORT = getenv('PGPORT') ?: '5432';
$DB_NAME = getenv('PGDATABASE') ?: 'quiz';
$DB_USER = getenv('PGUSER') ?: 'quiz_admin';
$DB_PASS = getenv('PGPASSWORD') ?: 'quizzical';

// ======== HELPERS ========
function pg() {
    static $pdo = null; global $DB_HOST,$DB_PORT,$DB_NAME,$DB_USER,$DB_PASS;
    if ($pdo === null) {
        $dsn = "pgsql:host={$DB_HOST};port={$DB_PORT};dbname={$DB_NAME};";
        $pdo = new PDO($dsn, $DB_USER, $DB_PASS, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }
    return $pdo;
}

function respond_json($data, $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

function respond_forbidden($msg='Forbidden') {
    http_response_code(403);
    echo $msg;
    exit;
}

function get_param($key, $default=null) {
    return $_GET[$key] ?? $_POST[$key] ?? $default;
}

function normalize_answer($s) {
    // lowercase
    $s = mb_strtolower($s, 'UTF-8');
    // transliterate diacritics -> ASCII
    $s = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
    // keep only ascii letters and digits
    $s = preg_replace('/[^a-z0-9]+/', '', $s);
    return $s ?? '';
}

function fetch_team($team) {
    $stmt = pg()->prepare('SELECT team_id, is_admin, cooldown_end, cooldown_length FROM teams WHERE team_id = :t;');
    $stmt->execute([':t' => $team]);
    return $stmt->fetch();
}

function html_base() {
    // Serve quiz.html (static) so JS/CSS can load separately
    $htmlPath = __DIR__ . '/quiz.html';
    if (!is_file($htmlPath)) {
        http_response_code(500);
        echo 'quiz.html is missing';
        exit;
    }
    header('Content-Type: text/html; charset=utf-8');
    // We do not template-inject team id; JS reads it from URL.
    readfile($htmlPath);
    exit;
}

function verify_team(): ?array
{
    $team = get_param('team');
    if (!$team || !preg_match('/^[A-Fa-f0-9]{8}$/', $team)) {
        return null;
    }

    $teamRow = fetch_team(strtolower($team));
    if (!$teamRow) {
        return null;
    }
    return $teamRow;
}

// ======== ENDPOINTS ========

function get_status($teamRow) {
    $stmt = pg()->prepare(<<<EOL
        SELECT team_id, time, round, letter, answered, points 
        FROM actions 
        WHERE team_id = :t 
        ORDER BY time DESC, round DESC, letter ASC
EOL
    );
    $stmt->execute([':t' => $teamRow['team']]);
    $my_actions = $stmt->fetchAll();

    // Scoreboard: points by team per round and totals
    $scoreSql = 'SELECT a.team_id, a.round, COALESCE(SUM(a.points),0) AS points
                 FROM actions a
                 GROUP BY a.team_id, a.round
                 ORDER BY a.team_id, a.round';
    $rows = pg()->query($scoreSql)->fetchAll();
    $scoreboard = [];
    foreach ($rows as $r) {
        $tid = $r['team_id'];
        if (!isset($scoreboard[$tid])) $scoreboard[$tid] = ['team_id'=>$tid,'per_round'=>[], 'total'=>0];
        $scoreboard[$tid]['per_round'][(int)$r['round']] = (int)$r['points'];
        $scoreboard[$tid]['total'] += (int)$r['points'];
    }

    // Also include current round and its config
    $roundRow = pg()->query('SELECT round, value, active FROM rounds WHERE active > 0 ORDER BY active DESC LIMIT 1')->fetch();

    return [
        'team' => $teamRow,
        'now' => (new DateTimeImmutable('now'))->format(DateTimeInterface::ATOM),
        'current_round' => $roundRow,
        'my_actions' => $my_actions,
        'scoreboard' => array_values($scoreboard),
    ];
}

// ======== REQUEST BOOTSTRAP ========
$teamRow = verify_team();
if(!$teamRow) {
    respond_forbidden('Error 403');
}
$cmd = strtolower((string) get_param('cmd', ''));
$json = null;
switch ($cmd) {
    case 'status':
        $json = get_status($teamRow);
        break;
    case 'guess':
        break;
}

if ($cmd === '') {
    // Serve SPA shell
    html_base();
}


if ($cmd === 'guess' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $round = (int) get_param('round');
    $question = (string) get_param('question');
    $rawAnswer = file_get_contents('php://input') ?: '';

    // Transaction for consistency
    $pdo = pg();
    $pdo->beginTransaction();
    try {
        // Reload team row FOR UPDATE (cooldowns may change)
        $stmt = $pdo->prepare('SELECT team_id, is_admin, cooldown_end, cooldown_length FROM teams WHERE team_id = :t FOR UPDATE');
        $stmt->execute([':t' => $team]);
        $teamRow = $stmt->fetch();

        $now = new DateTimeImmutable('now');
        if ($teamRow['cooldown_end'] && new DateTimeImmutable($teamRow['cooldown_end']) > $now) {
            $pdo->rollBack();
            respond_json(['points'=>0, 'reason'=>'cooldown']);
        }

        // Check round active and get its config FOR UPDATE (we modify first_team potentially)
        $stmt = $pdo->prepare('SELECT round, value, active FROM rounds WHERE round = :r FOR UPDATE');
        $stmt->execute([':r' => $round]);
        $roundRow = $stmt->fetch();
        if (!$roundRow || (int)$roundRow['active'] <= 0) {
            $pdo->rollBack();
            respond_json(['points'=>0, 'reason'=>'inactive_round']);
        }

        // Check not already answered by this team for this (round,question)
        $stmt = $pdo->prepare('SELECT 1 FROM actions WHERE team_id = :t AND round = :r AND letter = :q LIMIT 1');
        $stmt->execute([':t'=>$team, ':r'=>$round, ':q'=>$question]);
        if ($stmt->fetchColumn()) {
            $pdo->rollBack();
            respond_json(['points'=>0, 'reason'=>'already_answered']);
        }

        // Load canonical answer
        $stmt = $pdo->prepare('SELECT answer FROM questions WHERE round = :r AND question = :q');
        $stmt->execute([':r'=>$round, ':q'=>$question]);
        $ansRow = $stmt->fetch();

        $normUser = normalize_answer($rawAnswer);
        $normDb   = normalize_answer($ansRow['answer'] ?? '');

        $points = -1; // default = wrong
        if ($ansRow && $normUser !== '' && $normUser === $normDb) {
            // Correct — compute score
            $base = (int)$roundRow['value'];
            $active = max(1, (int)$roundRow['active']);
            $score = intdiv($base, $active);
            $points = $score;
        } else {
            // Wrong — start/extend cooldown
            $len = max(30, (int)$teamRow['cooldown_length']);
            $newLen = min($len * 2, 480);
            $stmt = $pdo->prepare("UPDATE teams SET cooldown_end = NOW() + make_interval(secs => :len), cooldown_length = :new WHERE team_id = :t");
            $stmt->execute([':len'=>$len, ':new'=>$newLen, ':t'=>$team]);
        }

        // Record action (store the raw text the user sent)
        $stmt = $pdo->prepare('INSERT INTO actions(team_id, time, round, letter, answered, points) VALUES (:t, NOW(), :r, :q, :a, :p)');
        $stmt->execute([':t'=>$team, ':r'=>$round, ':q'=>$question, ':a'=>$rawAnswer, ':p'=>$points]);

        $pdo->commit();
        respond_json(['points'=>$points]);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        respond_json(['error'=>'server_error','message'=>$e->getMessage()], 500);
    }
}

if ($cmd === 'round') {
    // Admin only
    if (!$teamRow['is_admin']) { respond_forbidden('Error 403'); }
    $round = (int) get_param('round');
    $active = (int) get_param('active');

    $pdo = pg();
    $pdo->beginTransaction();
    try {
        // Reset all actives to 0, then set the specified round value
        $pdo->exec('UPDATE rounds SET active = 0');
        $stmt = $pdo->prepare('UPDATE rounds SET active = :a WHERE round = :r');
        $stmt->execute([':a'=>$active, ':r'=>$round]);
        $pdo->commit();
        respond_json(['ok'=>true]);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        respond_json(['error'=>'server_error','message'=>$e->getMessage()], 500);
    }
}

// Unknown command
respond_json(['error'=>'unknown_command'], 400);
