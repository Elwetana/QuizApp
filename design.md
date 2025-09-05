# We are developing a client application for pub quiz.

The application is a simple, single-page application, written in pure HTML, CSS and JavaScript. The server is a single PHP file. So I expect the whole app to consists of the following files:

* quiz.php
* quiz.html
* quiz.css
* quiz.js

Furthermore, the application will be accessing Postgresql database as the user quiz. The database has the following tables:

* teams
  * team_id varchar 8 PK
  * name text
  * locked Boolean default false
  * is_admin Boolean (only one can be true)
  * cooldown_end timestamp without timezone default now()
  * cooldown_length integer default 30 //in seconds
* teams_per_round
  * team_id varchar 8 PK, FK to Teams
  * round integer PK, FK to Rounds
  * score integer not null default 0
* questions
  * round integer not null PK, FK to rounds
  * letter character not null PK
  * question text not null
  * hint1 text
  * hint2 text
  * answer text not null
* actions
  * team_id varchar 8, FK to teams
  * time timestamp without timezone
  * round integer FK to questions
  * letter character FK to questions
  * answered text
  * points integer
* rounds
  * round integer PK
  * name text
  * length integer not null //time in seconds
  * active integer default 0 //0 = not started, 1 = in progress, 2 = completed
  * started timestamp without timezone
  * value integer not null

The primary access device is a mobile phone, desktop performance and ergonomics are not important.

# Server
The server is accessed on URL “https://www.argenite.org/quiz.php?team=<team code>” where <team code> is 8 characters hexa string (e.g. DEAD1337). If the team code is not present or if it does not match any of the known teams (as per table teams), it will return Error 403

If the team exists, the server will return base HTML of the application, with links to JS and CSS files.

The server supports three “user” commands; both are only valid when accompanied by the correct team code. These commands are:

## Status
This is a simple GET request. Will return the list of actions for the given team in a JSON, pretty much straightforward select  * from actions where team_id = ? and list of points earned by the other teams per round and in previous rounds, so that the client can display the current state of the game. If there is active round (any row in table Rounds has active = 1), the server will include also questions text from table Questions. If it is already more than length (column in table Rounds) seconds from the start of the round (column started in table Rounds), the server will also send values in column hint1 in table Questions. If more than two times length seconds have passed from the start of the round, column hint2 will be included as well.

## Guess
This is a POST request with the following parameters: team code and question letter. The answer itself is in the body of the request. It returns the number of points scored, if the number is negative, it means that the answer is wrong.

## Rename
This is a POST request with the parameter team code and new team name in the body of the post request. This command is valid only if team code is valid, there is no active question and the locked column for that team is false.

Then there are admin commands:

## Round
This is a GET request with parameters team, round and active. The command is only valid if the team has column is_admin set to true. In that case, it will set the value of column active in table Rounds for the supplied round to the supplied value. If the supplied value of active is 1, check that all rounds are set to either 0 or 2, if yes also set the column started to now(). If the value supplied is 2 or 0, check that the current value is 1. If either of the checks mentioned above fail, return error and do nothing. If the new value of active is 2, perform end of round scoring described in section Rules for scoring end of round.

## Define
This is POST request with parameter team that must be the admin team. The body of the post request contains JSON with data for the tables questions, rounds and teams.

## Reset
Delete all rows in Teams_per_round and Actions, set active in all rounds to 0, set all cooldowns in Teams to their default values

## Rules for guessing
Perform the following checks:

1. Check if the team is not under cooldown, see rules for cooldowns below. If yes, return 0.
1. Check if the team hasn’t already answered this question successfully. It is not possible to answer the same questions multiple times. If yes, return 0.
1. Check if there is an active round, i.e. table Round has one row with column active set to true

Now we can start processing the answer:

## Check for match, start cooldown if no match
The answer provided by the team is converted to lowercase and stripped of diacritical marks (normalized to NFD and filtered for all non-ascii characters) and then regex match is performed with answer in table Questions as regex expression. 

If there is no match, update actions table with this wrong attempt and set points to 0

If there is a match, the team will be scored, based on the following rules:

## Rules for scoring
* Base score is column value in table round
* Determine the phase of the round. Check columns length and started in table Rounds.
* If we are within this interval (i.e. now() < started + length  * interval ‘1 second’, then use base score
* For every complete elapsed interval of length seconds, divide the base score by 2 (so e.g. if  started + 2  * length  * interval ‘1 second’ < now() < started + 3  * length  * interval ‘1 second’, divide by 4

Finally update actions table and return 0. The teams do not now if the guess was successful or not.

## Rules for scoring end of round
When admin team sets active column of table Rounds to 2, that round will be scored. Follow these rules:

* Determine order or the teams:
  * Teams are ordered by the score achieved in this round. The score is in this round is the sum of the points value of their latest guess (wrong guesses have point value 0)
  * In case of a tie, the ties are broken by the order of the last successful guess of the teams (i.e. team with the earlier last successful guess wins)
  * If the tie persists, the order is broken by the second last guess and so on.
  * If the tie persists, the order is broken randomly
* The teams in first half (rounded up) will be awarded points by this formula:
  * The column value in table Rounds plus
  * Their score in this round divided by the maximum number of points that could be scored (i.e. number of questions times value column in Rounds), divided by ten.

Insert new row for each team into the teams_per_round table with the final score for this round.

Example:

The column value in Rounds is 4, there were 5 questions. Four teams (A, B, C, D) scored 12, 10, 10 and 8 points. Team C has had last successful guess 150 seconds after the start of the round, while team B did at 180 seconds after the start of the round. The final order is therefore A, C, B, D. So in the end, A score 4.06 (= 4 + 12 / 20 / 10) and team C scores 4.05 (= 4 + 10 / 20 / 10) points. Teams B and D score 0.

# Client
The client has four main areas that can be switched between using tabs at the top of the screen:

## Situation
Shows points earned by the other teams in this round, the score from previous rounds and who is currently winning, both in this round and overall

## History
Shows the actions performed by the team in this and previous rounds, how many points it earned.

## Guess
Shows a row of buttons to choose the question that will be answered, text area where the  answer can be written, and submit button.

## Questions
Shows a list of questions in this round. If hint1 and hint2 were included, they will be displayed as well. Every question should have button Answer that will take the player to tab Guess with the right question letter selected.

The Admin “team” has one more tab:

## Round
This has row of buttons to select round and a numeric input field to set value of column active and a submit button.

# Changes from the design to be implemented

* [ ] Do not return points for the current round, the team will only learn about the score from the round at the end of the round
* [ ] Feed client information about all rounds, so that the teams can see how many points can be won in future
* [ ] Allow pictures as questions
* [ ] Unify Questions and Guess tabs
* [ ] Add Help tab for Players
* [ ] Better info about previous actions
* [ ] Better info about situation
* [ ] Store answer before normalizing (but after some cleaning)
* [ ] Create 'quiz master' client