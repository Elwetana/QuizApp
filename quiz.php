<?php
// quiz.php — single entry point and API for the Pub Quiz

// ======== CONFIG ========
use JetBrains\PhpStorm\NoReturn;

$DB_HOST = getenv('PGHOST') ?: 'localhost';
$DB_PORT = getenv('PGPORT') ?: '5432';
$DB_NAME = getenv('PGDATABASE') ?: 'quiz';
$DB_USER = getenv('PGUSER') ?: 'quiz_admin';
$DB_PASS = getenv('PGPASSWORD') ?: '';

enum FetchType: int
{
    case FetchTeam = 0;
    case FetchActions = 1;
    case FetchScoreRound = 2;
    case FetchScoreTotal = 3;
    case GetActiveRound = 4;
    case FetchQuestions = 5;
}

function pg()
{
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

/**
 * @param $name FetchType
 * @param $team_id ?string
 * @return bool|array
 */
function fetch_db_data(FetchType $name, string $team_id=null): bool|array
{
    $sql = [
        FetchType::FetchTeam->value => <<<EOL
    SELECT * FROM teams WHERE team_id=:t;
EOL,
        FetchType::FetchActions->value => <<<EOL
    SELECT time,round,letter,answered,points 
    FROM actions 
    WHERE team_id=:t 
    ORDER BY time DESC;
EOL,
        FetchType::FetchScoreRound->value => <<<EOL
    SELECT team_id, COALESCE(SUM(points),0) AS pts 
    FROM actions
        join rounds using(round)
    WHERE active = 1 AND points > 0 
    GROUP BY team_id
EOL,
        FetchType::FetchScoreTotal->value => <<<EOL
    SELECT team_id, round, score 
    FROM teams_per_round GROUP BY team_id;
EOL,
        FetchType::GetActiveRound->value => <<<EOL
    select * from rounds where active = 1;
EOL,
        FetchType::FetchQuestions->value => <<<EOL
    SELECT 
        round, letter, question,
        case when now() > started + length * interval '1 second' then hint1 end as hint1,
        case when now() > started + 2 * length * interval '1 second' then hint2 end as hint2
    FROM 
        questions
        join rounds using(round)
    WHERE active = 1
    ORDER BY letter
EOL

    ];
    $stmt = pg()->prepare($sql[$name->value]);
    $params = ($team_id === null) ? null : [':t' => $team_id];
    $stmt->execute($params);
    return $stmt->fetchAll();
}




function verify_team(): ?array
{
    $team = get_param('team');
    if (!$team || !preg_match('/^[A-Fa-f0-9]{8}$/', $team)) {
        return null;
    }

    $teamRow = fetch_db_data('fetch_team', team_id: strtolower($team));
    if (!$teamRow) {
        return null;
    }
    return $teamRow;
}

function respond_json($data,$code=200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data,JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT);
    exit;
}

function respond_forbidden() {
    http_response_code(403);
    echo "Error 403";
    exit;
}

function get_param($k, $default=null) {
    return $_GET[$k] ?? $_POST[$k] ?? $default;
}

function normalize_answer($s): string {
    // lowercase
    $s = mb_strtolower($s, 'UTF-8');
    // transliterate diacritics -> ASCII
    $s = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
    // keep only ascii letters and digits
    $s = preg_replace('/[^a-z0-9]+/', '', $s);
    return $s ?? '';
}

function html_base()
{
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

// ======== STATUS ========
function get_status($teamRow): array
{
    return [
        'team'           => $teamRow,
        'current_round'  => fetch_db_data(FetchType::GetActiveRound),
        'current_scores' => fetch_db_data(FetchType::FetchScoreRound),
        'overall_totals' => fetch_db_data(FetchType::FetchScoreTotal),
        'my_actions'     => fetch_db_data(FetchType::FetchActions, team_id: $teamRow['team_id']),
        'questions'      => fetch_db_data(FetchType::FetchQuestions)
    ];
}

function make_guess($team_row)
{
    $letter = strtoupper((string)get_param('letter',''));


    $roundRow = active_round_row($pdo);
    if(!$roundRow) respond_json(['points'=>0,'reason'=>'no_active']);

    $now = new DateTimeImmutable('now');
    if(!empty($teamRow['cooldown_end']) && new DateTimeImmutable($teamRow['cooldown_end']) > $now){
        respond_json(['points'=>0,'reason'=>'cooldown']);
    }

    // prevent duplicate successful answer
    $st=$pdo->prepare('SELECT 1 FROM actions WHERE team_id=:t AND round=:r AND letter=:l AND points>0 LIMIT 1');
    $st->execute([':t'=>$team, ':r'=>$roundRow['round'], ':l'=>$letter]);
    if($st->fetchColumn()) respond_json(['points'=>0,'reason'=>'already_answered']);

    // Fetch canonical regex answer
    $st=$pdo->prepare('SELECT answer FROM questions WHERE round=:r AND letter=:l');
    $st->execute([':r'=>$roundRow['round'], ':l'=>$letter]);
    $regex = $st->fetchColumn();

    $raw = file_get_contents('php://input') ?: '';
    $norm = normalize_answer($raw);

    $ok = false;
    if($regex){
        // Stored regex is applied to normalized string
        $delim = '~';
        $ok = @preg_match($delim.$regex.$delim.'i', $norm) === 1;
    }

    $points = -1;
    $pdo->beginTransaction();
    try{
        if($ok){
            $base = max(0,(int)$roundRow['value']);
            $len = max(1,(int)$roundRow['length']);
            $started = new DateTimeImmutable($roundRow['started']);
            $elapsed = max(0,$now->getTimestamp() - $started->getTimestamp());
            $intervals = intdiv($elapsed, $len);
            $div = 1; for($i=0;$i<$intervals;$i++) $div*=2;
            $points = intdiv($base, $div);
        } else {
            $len = max(30,(int)$teamRow['cooldown_length']);
            $newLen = min($len*2,480);
            $upd=$pdo->prepare('UPDATE teams SET cooldown_end = NOW() + make_interval(secs=>:s), cooldown_length=:nl WHERE team_id=:t');
            $upd->execute([':s'=>$len, ':nl'=>$newLen, ':t'=>$team]);
        }
        $ins=$pdo->prepare('INSERT INTO actions(team_id,time,round,letter,answered,points) VALUES(:t,NOW(),:r,:l,:a,:p)');
        $ins->execute([':t'=>$team, ':r'=>$roundRow['round'], ':l'=>$letter, ':a'=>$raw, ':p'=>$points]);
        $pdo->commit();
        respond_json(['points'=>$points]);
    }catch(Throwable $e){ if($pdo->inTransaction()) $pdo->rollBack(); respond_json(['error'=>'server_error'],500);}

}


// ======== BOOTSTRAP ========
$teamRow = verify_team();
if(!$teamRow) {
    respond_forbidden('Error 403');
}
$cmd = strtolower((string)get_param('cmd', ''));
$json = null;
switch ($cmd) {
    case 'status':
        $json = get_status($teamRow);
        break;
    case 'guess':
        if($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond_forbidden();
        }
        $json = make_guess($teamRow);
        break;
}



if ($cmd === '') {
    // Serve SPA shell
    html_base();
}



// ======== RENAME ========
if($cmd==='rename' && $_SERVER['REQUEST_METHOD']==='POST'){
    // Only when no active round and team is not locked
    $hasActive = $pdo->query('SELECT 1 FROM rounds WHERE active=1')->fetchColumn();
    if($teamRow['locked'] || $hasActive){ respond_json(['ok'=>false]); }
    $newName = trim(file_get_contents('php://input') ?: '');
    if($newName===''){ respond_json(['ok'=>false]); }
    $st=$pdo->prepare('UPDATE teams SET name=:n WHERE team_id=:t');
    $st->execute([':n'=>$newName, ':t'=>$team]);
    respond_json(['ok'=>true]);
}

// ======== ROUND (ADMIN) ========
if($cmd==='round'){
    if(!$teamRow['is_admin']) respond_forbidden();
    $round = (int)get_param('round');
    $newActive = (int)get_param('active'); // 0,1,2

    $pdo->beginTransaction();
    try{
        $st=$pdo->prepare('SELECT active FROM rounds WHERE round=:r FOR UPDATE');
        $st->execute([':r'=>$round]);
        $cur = $st->fetch();
        if(!$cur){ throw new RuntimeException('round_missing'); }
        $curActive = (int)$cur['active'];

        if($newActive===1){
            // ensure no other active=1 exists
            $other = $pdo->query('SELECT 1 FROM rounds WHERE active=1')->fetchColumn();
            if($other){ throw new RuntimeException('another_active'); }
            $st=$pdo->prepare('UPDATE rounds SET active=1, started=NOW() WHERE round=:r');
            $st->execute([':r'=>$round]);
        } elseif($newActive===0 || $newActive===2){
            if($curActive!==1){ throw new RuntimeException('not_in_progress'); }
            $st=$pdo->prepare('UPDATE rounds SET active=:a WHERE round=:r');
            $st->execute([':a'=>$newActive, ':r'=>$round]);
            if($newActive===2){
                // End-of-round scoring
                // 1) Per-team round score
                $scores = [];
                $res = $pdo->prepare('SELECT team_id, COALESCE(SUM(points),0) AS pts FROM actions WHERE round=:r AND points>0 GROUP BY team_id');
                $res->execute([':r'=>$round]);
                foreach($res as $row){ $scores[$row['team_id']] = (int)$row['pts']; }
                if($scores){
                    // 2) Successful guess times per team (ascending)
                    $times = [];
                    $res = $pdo->prepare('SELECT team_id, time FROM actions WHERE round=:r AND points>0 ORDER BY time ASC');
                    $res->execute([':r'=>$round]);
                    foreach($res as $row){ $times[$row['team_id']][] = $row['time']; }
                    // 3) Questions count and value
                    $qcount = (int)($pdo->prepare('SELECT COUNT(*) FROM questions WHERE round=:r')->execute([':r'=>$round])||1);
                    $stQ = $pdo->prepare('SELECT COUNT(*) AS c FROM questions WHERE round=:r'); $stQ->execute([':r'=>$round]); $qcount = (int)$stQ->fetchColumn();
                    $stV = $pdo->prepare('SELECT value FROM rounds WHERE round=:r'); $stV->execute([':r'=>$round]); $value = (int)$stV->fetchColumn();

                    // 4) Order teams: by score desc, then earlier last success, then earlier 2nd last, etc., else random
                    $teamIds = array_keys($scores);
                    usort($teamIds, function($A,$B) use ($scores,$times){
                        if($scores[$A]!==$scores[$B]) return $scores[$B] <=> $scores[$A];
                        $ta = $times[$A] ?? []; $tb = $times[$B] ?? [];
                        // compare from last success backward (earlier wins)
                        for($i=1;;$i++){
                            $ia = $ta[count($ta)-$i] ?? null; $ib = $tb[count($tb)-$i] ?? null;
                            if($ia===null && $ib===null) break;
                            if($ia===null) return -1; // A had fewer successes -> earlier by definition
                            if($ib===null) return 1;
                            if($ia !== $ib) return strcmp($ia,$ib); // earlier (smaller) first
                        }
                        return rand(-1,1);
                    });

                    // 5) Award first half (rounded up)
                    $n = count($teamIds);
                    $eligible = (int)ceil($n/2);
                    $maxPossible = max(1, $qcount * max(1,$value));
                    $ins = $pdo->prepare('INSERT INTO teams_per_round(team_id,round,score) VALUES(:t,:r,:s)');
                    for($i=0;$i<$eligible;$i++){
                        $tid = $teamIds[$i];
                        $frac = ($scores[$tid]/$maxPossible)/10.0; // e.g., 12/20/10 = 0.06
                        $final = $value + $frac; // decimal
                        $centi = (int)round($final*100); // store as integer centipoints
                        $ins->execute([':t'=>$tid, ':r'=>$round, ':s'=>$centi]);
                    }
                }
            }
        } else {
            throw new RuntimeException('bad_active');
        }
        $pdo->commit();
        respond_json(['ok'=>true]);
    }catch(Throwable $e){ if($pdo->inTransaction()) $pdo->rollBack(); respond_json(['ok'=>false,'error'=>$e->getMessage()],400); }
}

// ======== DEFINE (ADMIN) ========
if($cmd==='define' && $_SERVER['REQUEST_METHOD']==='POST'){
    if(!$teamRow['is_admin']) respond_forbidden();
    $payload = json_decode(file_get_contents('php://input') ?: '[]', true);
    if(!is_array($payload)) respond_json(['ok'=>false,'error'=>'bad_json'],400);
    $pdo->beginTransaction();
    try{
        if(isset($payload['teams'])){
            $ins=$pdo->prepare('INSERT INTO teams(team_id,name,locked,is_admin,cooldown_end,cooldown_length) VALUES(:id,:name,COALESCE(:locked,false),COALESCE(:admin,false),NOW(),30)
                                ON CONFLICT (team_id) DO UPDATE SET name=EXCLUDED.name, locked=EXCLUDED.locked, is_admin=EXCLUDED.is_admin');
            foreach($payload['teams'] as $t){ $ins->execute([':id'=>$t['team_id'],':name'=>$t['name']??null,':locked'=>$t['locked']??false,':admin'=>$t['is_admin']??false]); }
        }
        if(isset($payload['rounds'])){
            $ins=$pdo->prepare('INSERT INTO rounds(round,name,length,active,started,value) VALUES(:r,:n,:l,0,NULL,:v)
                                ON CONFLICT (round) DO UPDATE SET name=EXCLUDED.name, length=EXCLUDED.length, value=EXCLUDED.value');
            foreach($payload['rounds'] as $r){ $ins->execute([':r'=>$r['round'], ':n'=>$r['name']??null, ':l'=>$r['length'], ':v'=>$r['value']]); }
        }
        if(isset($payload['questions'])){
            $del=$pdo->prepare('DELETE FROM questions WHERE round=:r');
            $ins=$pdo->prepare('INSERT INTO questions(round,letter,question,hint1,hint2,answer) VALUES(:r,:l,:q,:h1,:h2,:a)');
            // Group by round and replace questions for those rounds
            $byRound=[]; foreach($payload['questions'] as $q){ $byRound[$q['round']][]=$q; }
            foreach($byRound as $r=>$qs){ $del->execute([':r'=>$r]); foreach($qs as $q){ $ins->execute([':r'=>$q['round'],':l'=>$q['letter'],':q'=>$q['question'],':h1'=>$q['hint1']??null,':h2'=>$q['hint2']??null,':a'=>$q['answer']]); } }
        }
        $pdo->commit();
        respond_json(['ok'=>true]);
    }catch(Throwable $e){ if($pdo->inTransaction()) $pdo->rollBack(); respond_json(['ok'=>false,'error'=>'server_error'],500);}
}

// ======== RESET (ADMIN) ========
if($cmd==='reset'){
    if(!$teamRow['is_admin']) respond_forbidden();
    $pdo->beginTransaction();
    try{
        $pdo->exec('DELETE FROM teams_per_round; DELETE FROM actions; UPDATE rounds SET active=0, started=NULL; UPDATE teams SET cooldown_end=NOW(), cooldown_length=30;');
        $pdo->commit();
        respond_json(['ok'=>true]);
    }catch(Throwable $e){ if($pdo->inTransaction()) $pdo->rollBack(); respond_json(['ok'=>false],500);}
}

respond_json(['error'=>'unknown'],400);
?>























<-- ?php





// ======== ENDPOINTS ========
function get_status($teamRow) {

    $my_actions = fetch_db_data('fetch_actions', team_id: $teamRow['team']);
    // Scoreboard: points by team per round and totals
    $scoreSql =
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

function make_guess($teamRow) {
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

// ======== REQUEST BOOTSTRAP ========


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
? -->