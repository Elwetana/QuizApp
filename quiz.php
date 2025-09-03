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
    case ExtendCooldown = 6;
    case SubmitGuess = 7;
    case RenameTeam = 8;
    case CloseRound = 9;
    case StartRound = 10;
    case EndRound = 11;
    case TotalRound = 12;
}

function pg(): ?PDO
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
 * @param string|null $letter
 * @param string|null $answer
 * @return bool|array
 */
function fetch_db_data(FetchType $name, string $team_id=null, string $letter=null, string $answer=null): bool|array
{
    $sql = [
        FetchType::FetchTeam->value => <<<EOL
    SELECT *, cooldown_end > now() as cooldown_active 
    FROM teams 
    WHERE team_id=:t;
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
    FROM teams_per_round;
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
EOL,
        FetchType::ExtendCooldown->value => /** @lang PostgreSQL */ <<<EOL
    with v as (
        select team_id, case when cooldown_end > now() then cooldown_length else 30 end as cl
        from teams
        where team_id = :t
    )
    update
        teams
    set
        cooldown_end = now() + cl * interval '1 second',
        cooldown_length = least(480, 2 * cl)
    from v
        where v.team_id = teams.team_id
    returning cooldown_end;    
EOL,
        FetchType::SubmitGuess->value => /** @lang PostgreSQL */ <<<EOL
    with check_answer as (
        select
            round, letter,
            :a ~ answer as is_match,
            value,
            case when started + length * interval '1 second' < now() then 0.5 else 1 end as hint1_mod,
            case when started + 2 * length * interval '1 second' < now() then 0.5 else 1 end as hint2_mod
        from
            questions
            join rounds using (round)
        where active = 1 and letter = :l
    )
    insert into
        actions(team_id, time, round, letter, answered, points)
    select :t, now(), round, letter, :a, case when is_match then value * hint1_mod * hint2_mod else -1 end
    from check_answer
    returning points;
EOL,
        FetchType::RenameTeam->value => /** @lang PostgreSQL */ <<<EOL
    with is_active as (
        select max(case when active = 2 then 0 else active end) as a
        from rounds
    )
    update teams set name = case when is_active.a = 0 and not locked then :a else name end
    from is_active
    where team_id = :t
    returning is_active.a = 0 and not locked as updated;
EOL,
        FetchType::CloseRound->value => /** @lang PostgreSQL */ <<<EOL
    update rounds
    set active = 0
    where round = :t
    returning true;
EOL,
        FetchType::StartRound->value => /** @lang PostgreSQL */ <<<EOL
    with v as (
        select
            round,
            case when active = 0 then true else false end as can_start
        from rounds
        where round = :t
    )
    update rounds
    set 
        started = case when can_start then now() else started end,
        active = case when can_start then 1 else active end
    from v
    where v.round = rounds.round
    returning can_start;
EOL,
        FetchType::EndRound->value => /** @lang PostgreSQL */ <<<EOL
    with v as (
        select
            round,
            case when active = 1 then true else false end as can_end
        from rounds
        where round = :t
    )
    update rounds
    set 
        active = case when can_end then 2 else active end
    from v
    where v.round = rounds.round
    returning can_end;
EOL,
        FetchType::TotalRound->value => /** @lang PostgreSQL */ <<<EOL
    with
        n_teams as (
            select count(1) as n
            from teams
            where not is_admin
        ),
        cur_round as (
            select round, value, started
            from rounds
            where round = :t
        ),
        last_attempts as (
            select team_id, letter, max(time) as time
            from actions
                 join cur_round using(round)
            group by team_id, letter
        ),
        scores as (
            select sum(points) as s, max(extract(epoch from time - started)) as t, team_id
            from
                cur_round,
                last_attempts
                join actions using(team_id, letter, time)
            where points > 0
            group by team_id
        ),
        all_scores as (
            select team_id, coalesce(s, 0) as score, coalesce(t, 9999) as tiebreak
            from teams
            left join scores using(team_id)
            where not is_admin
        ),
        ranked as (
            select *, rank() over w as r
            from all_scores
            window w as (order by score desc, tiebreak asc)
        )
    insert into teams_per_round(team_id, round, score) 
    select team_id, round, value * 100 + (ceil(n_teams.n / 2) - r) as score
    from ranked, n_teams, cur_round
    where r <= ceil(n_teams.n / 2)
    returning team_id;
EOL
    ];

    // classify which should return a single row
    $single = [
        FetchType::FetchTeam->value,
        FetchType::GetActiveRound->value,
        FetchType::SubmitGuess->value,
        FetchType::ExtendCooldown->value,
        FetchType::RenameTeam->value,
        FetchType::CloseRound->value,
        FetchType::StartRound->value,
        FetchType::EndRound->value
    ];

    $params = [];
    if ($team_id !== null) $params[':t'] = $team_id;
    if ($answer  !== null) $params[':a'] = $answer;
    if ($letter  !== null) $params[':l'] = $letter;
    if (!$params) $params = null;

    $stmt = pg()->prepare($sql[$name->value]);
    $stmt->execute($params);
    if (in_array($name->value, $single, true)) {
        return $stmt->fetch();
    }
    return $stmt->fetchAll();
}

function verify_team(): ?array
{
    $team = get_param('team');
    if (!$team || !preg_match('/^[A-Fa-f0-9]{8}$/', $team)) {
        return null;
    }

    $teamRow = fetch_db_data(FetchType::FetchTeam, team_id: strtolower($team));
    if (!$teamRow) {
        return null;
    }
    return $teamRow;
}

function respond_json($data,$code=200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data,JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT);
}

#[NoReturn] function respond_forbidden(): void
{
    http_response_code(403);
    echo "Error 403";
    exit;
}

function get_param($k, $default=null)
{
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

function sanitize_team_name(string $name, int $maxLen=32): string
{
    // Keep letters (incl. accents), digits, space, underscore, dot, comma, dash
    $clean = preg_replace('/[^\p{L}\p{N} _.,-]/u', '', $name);
    $clean = trim($clean);

    // Enforce max length
    if (mb_strlen($clean, 'UTF-8') > $maxLen) {
        $clean = mb_substr($clean, 0, $maxLen, 'UTF-8');
    }
    return $clean;
}

function html_base(): void
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

function make_guess($team_row): array
{
    if($team_row['cooldown_active']) {
        return [
            'points' => 0,
            'reason'=>'cooldown_active'
        ];
    }

    $letter = strtoupper((string)get_param('letter',''));
    if(($letter === '') || !preg_match('/^[A-Z]$/', $letter)) {
        return [
            'points' => 0,
            'reason'=>'no_letter'
        ];
    }

    $raw = file_get_contents('php://input') ?: '';
    $norm = normalize_answer($raw);
    $award = fetch_db_data(FetchType::SubmitGuess, team_id: $team_row['team_id'], letter: $letter, answer: $norm);
    if (!$award) { //either wrong letter or (much more likely) no active round
        return [
            'points' => 0,
            'reason'=>'no_active'
        ];
    }

    if($award['points'] === "-1") {
        fetch_db_data(FetchType::ExtendCooldown, team_id: $team_row['team_id']);
    }
    return [
        'points' => 1,  //if we want to let the team know that they were successful, we would return $award here
        'reason'=>'guess_submitted'
    ];
}

function rename_team($teamRow): array
{
    $newName = sanitize_team_name(file_get_contents('php://input') ?: '');
    $updated = fetch_db_data(FetchType::RenameTeam, team_id: $teamRow['team_id'], answer: $newName);
    return [
        'updated' => $updated['updated']
    ];
}


//ADMIN endpoints
function update_round(): array
{
    $round = (int)get_param('round');
    $newActive = (int)get_param('active'); // 0,1,2
    $a = null;
    switch ($newActive) {
        case 0: //this does not make any sense gameplay wise, but it is admin's prerogative
            $a = fetch_db_data(FetchType::CloseRound, team_id: $round);
            break;
        case 1:
            $a = fetch_db_data(FetchType::StartRound, team_id: $round);
            break;
        case 2:
            $a = fetch_db_data(FetchType::EndRound, team_id: $round);
            break;
        default:
            respond_forbidden('Invalid active value');
    }
    $success = $a[array_key_first($a)];
    if($success && $newActive === 2) {
        $winners = fetch_db_data(FetchType::TotalRound, team_id: $round);
        return [
            'ok' => true,
            'winners' => $winners
        ];
    }
    return [
        'ok' => $success,
        'aa' => $a
    ];
}

function define_data(): array
{
    $payload = json_decode(file_get_contents('php://input') ?: '[]', true);
    if(!is_array($payload))
        return [
            'ok'=>false,
            'error'=>'bad_json'
        ];

    pg()->beginTransaction();
    try{
        if(isset($payload['teams'])) {
            $ins=pg()->prepare('INSERT INTO teams(team_id,name,locked,is_admin,cooldown_end,cooldown_length) VALUES(:id,:name,COALESCE(:locked,false),COALESCE(:admin,false),NOW(),30)
                                ON CONFLICT (team_id) DO UPDATE SET name=EXCLUDED.name, locked=EXCLUDED.locked, is_admin=EXCLUDED.is_admin');
            foreach($payload['teams'] as $t) {
                $ins->execute([':id'=>$t['team_id'],':name'=>$t['name']??null,':locked'=>$t['locked']??false,':admin'=>$t['is_admin']??false]);
            }
        }
        if(isset($payload['rounds'])){
            $ins=pg()->prepare('INSERT INTO rounds(round,name,length,active,started,value) VALUES(:r,:n,:l,0,NULL,:v)
                                ON CONFLICT (round) DO UPDATE SET name=EXCLUDED.name, length=EXCLUDED.length, value=EXCLUDED.value');
            foreach($payload['rounds'] as $r) {
                $ins->execute([':r'=>$r['round'], ':n'=>$r['name']??null, ':l'=>$r['length'], ':v'=>$r['value']]);
            }
        }
        if(isset($payload['questions'])) {
            $del=pg()->prepare('DELETE FROM questions WHERE round=:r');
            $ins=pg()->prepare('INSERT INTO questions(round,letter,question,hint1,hint2,answer) VALUES(:r,:l,:q,:h1,:h2,:a)');
            // Group by round and replace questions for those rounds
            $byRound=[]; foreach($payload['questions'] as $q){ $byRound[$q['round']][]=$q; }
            foreach($byRound as $r=>$qs) {
                $del->execute([':r'=>$r]);
                foreach($qs as $q) {
                    $ins->execute([':r'=>$q['round'],':l'=>$q['letter'],':q'=>$q['question'],':h1'=>$q['hint1']??null,':h2'=>$q['hint2']??null,':a'=>$q['answer']]);
                }
            }
        }
        pg()->commit();
        return ['ok'=>true];
    }
    catch(Throwable $e) {
        if(pg()->inTransaction())
            pg()->rollBack();
        return ['ok'=>false,'error'=>'server_error', 'ex' => $e];
    }
}

function reset_data(): array
{
    pg()->beginTransaction();
    try{
        pg()->exec('DELETE FROM teams_per_round; DELETE FROM actions; UPDATE rounds SET active=0, started=NULL; UPDATE teams SET cooldown_end=NOW(), cooldown_length=30;');
        pg()->commit();
        return ['ok'=>true];
    } catch(Throwable $e){
        if(pg()->inTransaction())
            pg()->rollBack();
        return['ok'=>false, 'ex' => $e];
    }
}

// ======== BOOTSTRAP ========
$teamRow = verify_team();
if(!$teamRow) {
    respond_forbidden();
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
    case 'rename':
        if($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond_forbidden();
        }
        $json = rename_team($teamRow);
        break;
    case 'round':
        if(!$teamRow['is_admin']) {
            respond_forbidden();
        }
        $json = update_round();
        break;
    case 'define':
        if(!$teamRow['is_admin'] || $_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond_forbidden();
        }
        $json = define_data();
        break;
    case 'reset':
        if(!$teamRow['is_admin']) {
            respond_forbidden();
        }
        $json = reset_data();
        break;
    default:
        html_base();
        exit();
}
respond_json($json);
