<?php
// quiz.php — single entry point and API for the Pub Quiz

// ======== CONFIG ========
$DB_HOST = getenv('PGHOST') ?: 'localhost';
$DB_PORT = getenv('PGPORT') ?: '5432';
$DB_NAME = getenv('PGDATABASE') ?: 'quiz';
$DB_USER = getenv('PGUSER') ?: 'quiz_admin';
$DB_PASS = getenv('PGPASSWORD') ?: '';

enum FetchType: int
{
    case FetchTeam = 0;
    case FetchActions = 1;
    case FetchRounds = 2;
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
    case ProgressRound = 13;
    case LastSeen = 14;
    case FetchAllTeams = 15;
    case FetchTeamAnswers = 16;
    case FetchAllAnswers = 17;
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
function fetch_db_data(FetchType $name, string $team_id=null, string $letter=null, string $answer=null, string $store=null): bool|array
{
    $sql = [
        FetchType::FetchTeam->value => /** @lang PostgreSQL */
        <<<EOL
    SELECT 
        *, extract('epoch' from (now() - last_seen)) as last_seen_age, 
        now()::timestamp without time zone as now
    FROM teams 
    WHERE team_id=:t
EOL,
        FetchType::FetchActions->value => <<<EOL
    SELECT time,round,letter,answered 
    FROM actions 
    WHERE team_id=:t 
    ORDER BY time DESC;
EOL,
        FetchType::FetchRounds->value => <<<EOL
    SELECT round, active, name, value 
    FROM rounds;
EOL,
        FetchType::FetchScoreTotal->value => <<<EOL
    select
        teams.name as team_id, round, coalesce(score, 0) as score, coalesce(round_score, 0) as round_score
    from teams
        cross join rounds
        left join teams_per_round using(team_id, round)
    where not is_admin;
EOL,
        FetchType::GetActiveRound->value => <<<EOL
    select * from rounds where active = 1;
EOL,
        FetchType::FetchQuestions->value => /** @lang PostgreSQL */ <<<EOL
    with r as (
        select round, started, length
        from rounds
        where active = 1 or active = 2
        order by active, round desc
        limit 1
    )
    SELECT
        round, letter, question,
        case when now() > started + length * interval '1 second' then hint1 end as hint1,
        case when now() > started + 1.5 * length * interval '1 second' then hint2 end as hint2
    FROM
        questions
            join r using(round)
    ORDER BY letter;
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
            4 as value,
            case when started + length * interval '1 second' < now() then 0.5 else 1 end as hint1_mod,
            case when started + 1.5 * length * interval '1 second' < now() then 0.5 else 1 end as hint2_mod
        from
            questions
            join rounds using (round)
        where active = 1 and letter = :l
    )
    insert into
        actions(team_id, time, round, letter, answered, points)
    select :t, now(), round, letter, :s, case when is_match then value * hint1_mod * hint2_mod else -1 end
    from check_answer
    returning points;
EOL,
        FetchType::RenameTeam->value => /** @lang PostgreSQL */ <<<EOL
    with is_active as (
        select max(active) as a
        from rounds
    ),
    is_dup as (
        select exists(select 1 from teams where team_id <> :t and name = :a) as dup
    )
    update teams set name = case when is_active.a = 0 and not locked then 
            :a || (case when dup then 
                ' ' || nextval('team_names')::text 
            else '' end) 
        else name end
    from is_active, is_dup
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
        last_answers as (
            select team_id, round, letter, answered, min(time) as time
            from actions
            join cur_round using (round)
            group by team_id, round, letter, answered
        ),
        last_attempts as (
            select team_id, round, letter, max(time) as time
            from last_answers
            group by team_id, round, letter
        ),
        scores as (
            select sum(points) as s, max(extract(epoch from time - started)) as t, team_id
            from
                last_attempts
                join cur_round using(round)
                join actions using(team_id, round, letter, time)
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
            where tiebreak < 9999
            window w as (order by score desc, tiebreak asc)
        )
    insert into teams_per_round(team_id, round, score, round_score) 
    select
        team_id, round, 
        case when r <= ceil(n_teams.n / 2) then value * 100 + (ceil(n_teams.n / 2) - r) else 0 end as score,
        ranked.score * 100 + n_teams.n - r as round_score
    from ranked, n_teams, cur_round
    on conflict (team_id, round) do update set score = excluded.score, round_score = excluded.round_score 
    returning team_id;
EOL,
        FetchType::ProgressRound->value =>  <<<EOL
    select
        teams.name as team,
        action_id, letter, points, answered
    from actions
    join rounds using (round)
    join teams using(team_id)
    where active = 1;
EOL,
        FetchType::LastSeen->value => /** @lang PostgreSQL */ <<<EOL
    update teams
    set last_seen = now()
    where team_id = :t
    returning last_seen;
EOL,
        FetchType::FetchAllTeams->value => <<<EOL
    select *, extract('epoch' from (now() - last_seen)) as age_last_seen
    from teams;
EOL,
        FetchType::FetchTeamAnswers->value => /** @lang PostgreSQL */ <<<EOL
    with
        last_round as (
            select max(round) as round
            from rounds
            where active = 2
        ),
        last_answers as (
            select team_id, round, letter, min(time) as time, answered
            from actions
                join last_round using(round)
            where team_id = :t
            group by team_id, round, letter, answered
        ),
        last_attempts as (
            select round, letter, team_id, max(time) as time
            from last_answers
            group by round, letter, team_id
        )
    select round, letter, time, answered, points, value
    from last_attempts
    join actions using(round, letter, team_id, time)
    join rounds using(round)
    order by letter;
EOL,
        FetchType::FetchAllAnswers->value => /** @lang PostgreSQL */ <<<EOL
    with
        last_round as (
            select max(round) as round
            from rounds
            where active = 2
        ),
        last_answers as (
            select team_id, round, letter, min(time) as time, answered
            from actions
                 join last_round using(round)
            group by team_id, round, letter, answered
        ),
        last_attempts as (
            select round, letter, team_id, max(time) as time
            from last_answers
            group by round, letter, team_id
        )
    select round, teams.name, letter, time, answered, points, value
    from last_attempts
        join actions using(round, letter, team_id, time)
        join rounds using(round)
        join teams using(team_id)
    order by letter, team_id;
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
        FetchType::EndRound->value,
        FetchType::LastSeen->value
    ];

    $params = [];
    if ($team_id !== null) $params[':t'] = $team_id;
    if ($answer  !== null) $params[':a'] = $answer;
    if ($letter  !== null) $params[':l'] = $letter;
    if ($store   !== null) $params[':s'] = $store;
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
    // Keep letters (incl. accents), digits, space, underscore, dot, comma, dash, colon
    $clean = preg_replace('/[^\p{L}\p{N} _.,:-]/u', '', $name);
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

function get_questions()
{
    $questions = fetch_db_data(FetchType::FetchQuestions);

    foreach ($questions as &$q) {
        $path = '';
        if (isset($q['question']) && str_starts_with($q['question'], 'file://')) {
            $path = substr($q['question'], 7); // strip "file://"
        }
        if (isset($q['hint1']) && str_starts_with($q['hint1'], 'file://')) {
            $path = substr($q['hint1'], 7); // strip "file://"
        }
        if (isset($q['hint2']) && str_starts_with($q['hint2'], 'file://')) {
            $path = substr($q['hint2'], 7); // strip "file://"
        }
        if($path !== '') {
            $fullPath = __DIR__ . '/' . ltrim($path, '/');
            if (is_file($fullPath)) {
                $q['question_type'] = 'image/png';
                $q['question'] = base64_encode(file_get_contents($fullPath));
            } else {
                $q['question'] = "not_found";
            }
            $q['hint1'] = '';
            $q['hint2'] = '';
        }
        else {
            $q['question_type'] = 'text';
        }
    }
    unset($q);
    return $questions;
}

function get_status($teamRow): array
{
    $ret = [
        'team'           => $teamRow,
        'current_round'  => fetch_db_data(FetchType::GetActiveRound),
        'all_rounds'     => fetch_db_data(FetchType::FetchRounds),
        'overall_totals' => fetch_db_data(FetchType::FetchScoreTotal),
        'my_actions'     => fetch_db_data(FetchType::FetchActions, team_id: $teamRow['team_id']),
        'questions'      => get_questions()
    ];
    if($teamRow['is_admin']) {
        $ret['round_progress'] = fetch_db_data(FetchType::ProgressRound);
        $ret['all_teams'] = fetch_db_data(FetchType::FetchAllTeams);
    }
    if(!$ret['current_round']) { //there is no current round, we can show responses to previous round
        if($teamRow['is_admin']) {
            $ret['all_answers'] = fetch_db_data(FetchType::FetchAllAnswers);
        }
        else {
            $ret['team_answers'] = fetch_db_data(FetchType::FetchTeamAnswers, $teamRow['team_id']);
        }
    }
    if($teamRow['last_seen'] === null) {
        $teamRow['last_seen'] = fetch_db_data(FetchType::LastSeen, $teamRow['team_id']);
    }
    return $ret;
}

function make_guess($team_row): array
{
    $letter = strtoupper((string)get_param('letter',''));
    if(($letter === '') || !preg_match('/^[A-Z]$/', $letter)) {
        return [
            'points' => 0,
            'reason'=>'no_letter'
        ];
    }

    $raw = file_get_contents('php://input') ?: '';
    $store = sanitize_team_name($raw);
    $norm = normalize_answer($store);
    $award = fetch_db_data(FetchType::SubmitGuess, team_id: $team_row['team_id'], letter: $letter, answer: $norm, store: $store);
    if (!$award) { //either wrong letter or (much more likely) no active round
        return [
            'points' => 0,
            'reason'=>'no_active'
        ];
    }

    return [
        'points' => 1,  //if we want to let the team know that they were successful, we would return $award here
        'reason'=>'guess_submitted'
    ];
}

function rename_team($teamRow): array
{
    $newName = sanitize_team_name(file_get_contents('php://input') ?: '');
    $updated = fetch_db_data(FetchType::RenameTeam, team_id: $teamRow['team_id'], answer: substr($newName, 0, 16));
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
        pg()->exec('DELETE FROM teams_per_round;');
        pg()->exec('DELETE FROM actions;');
        if(isset($payload['teams'])) {
            $del = pg()->prepare('DELETE FROM teams where not is_admin;');
            $del->execute();
            $ins=pg()->prepare('INSERT INTO teams(team_id,name) VALUES(:id,:name)');
            foreach($payload['teams'] as $t) {
                $ins->execute([':id'=>$t['team_id'],':name'=>$t['name']??null]);
            }
	}
        if(isset($payload['rounds'])){
            $del = pg()->prepare('DELETE FROM questions;');
	        $del->execute();
            $del = pg()->prepare('delete from rounds;');
	        $del->execute();
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

function define_people(): array
{
    $payload = json_decode(file_get_contents('php://input') ?: '[]', true);
    if(!is_array($payload))
        return [
            'ok'=>false,
            'error'=>'bad_json'
        ];

    pg()->beginTransaction();
    try{
        if(isset($payload['people'])) {
            pg()->exec('DELETE FROM people;');
            $ins=pg()->prepare('INSERT INTO people(people_id, name, login, primary_group, secondary_group, preference) VALUES(:id, :name, :login, :prim, :sec, :pref)');
            foreach($payload['people'] as $p) {
                $ins->execute([
                    ':id'=>$p['people_id'],
                    ':name'=>$p['name']??null,
                    ':login'=>$p['login']??null,
                    ':prim'=>$p['primary']??null,
                    ':sec'=>$p['secondary']??null,
                    ':pref'=>$p['preference']??null
                ]);
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
        pg()->exec('DELETE FROM teams_per_round;');
        pg()->exec('DELETE FROM actions;');
        pg()->exec('UPDATE rounds SET active=0, started=NULL;');
        pg()->exec(
<<<EOL
            with rr as (
                select team_id, rank() over (order by team_id) as r from teams
            ) 
            UPDATE teams SET cooldown_end=NOW(), cooldown_length=30, last_seen=null, name='Team ' || r
            from rr
            where rr.team_id = teams.team_id;
EOL
        );
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
    case 'people':
        if(!$teamRow['is_admin'] || $_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond_forbidden();
        }
        $json = define_people();
        break;
    default:
        html_base();
        exit();
}
respond_json($json);
