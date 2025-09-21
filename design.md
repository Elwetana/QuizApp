# We are developing a client application for pub quiz.

The application is a simple, single-page application, written in pure HTML, CSS and JavaScript. The server is a single PHP file. So I expect the whole app to consists of the following files:

* quiz.php
* quiz.html
* quiz.css
* quiz.js

Furthermore, the application will be accessing Postgresql database as the user quiz. The database has the following tables:

* people
  * people_id varchar 8 PK
  * name text
  * login text
  * primary_group integer
  * secondary_group integer
  * preference char
  * team_id varchar 8 FK to teams
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
  * round_score integer not null default 0
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
* teams_status
  * status integer //0 not started, 1 register interest only, 2 register interest and preference (random vs. self-organized teams), 3 team formation in progress, 4 teams are formed

The primary access device is a mobile phone, desktop performance and ergonomics are not important.

# Server
The server is accessed on URL “https://www.argenite.org/quiz.php?team=<team code>” where <team code> is 8 characters hex string (e.g. DEAD1337). If the team code is not present or if it does not match any of the known teams (as per table teams), it will return Error 403

If the team exists, the server will return base HTML of the application, with links to JS and CSS files.

The server supports three “user” commands; both are only valid when accompanied by the correct team code. These commands are:

## Status
This is a simple GET request. Will return the list of actions for the given team in a JSON, pretty much straightforward select  * from actions where team_id = ? and list of points earned by the other teams per round and in previous rounds, so that the client can display the current state of the game. If there is active round (any row in table Rounds has active = 1), the server will include also questions text from table Questions. If it is already more than length (column in table Rounds) seconds from the start of the round (column started in table Rounds), the server will also send values in column hint1 in table Questions. If more than 1.5 times length seconds have passed from the start of the round, column hint2 will be included as well.

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

## People
POST request that submits a JSON with property `people` that includes an array of records to be inserted into table `people`. Only available to admins.

## Rules for guessing
Perform the following checks:

1. Check if there is an active round, i.e. table Round has one row with column active set to true

Now we can start processing the answer:

## Check for match
The answer provided by the team is converted to lowercase and stripped of diacritical marks (normalized to NFD and filtered for all non-ascii characters) and then regex match is performed with answer in table Questions as regex expression. 

If there is no match, update actions table with this wrong attempt and set points to -1

If there is a match, the team will be scored, based on the following rules:

## Rules for scoring
* Base score is 4
* Determine the phase of the round. Check columns length and started in table Rounds.
* If we are within this interval (i.e. now() < started + length  * interval ‘1 second’), then use base score
* If we are after this interval, but within 1.5 * length seconds, divide base score by 2
+ If we are even later than this (i.e. now() > started + 1.5 * length * interval '1 second') then divide base score by 4 

Finally, update actions table and return 0. The teams do not know if the guess was successful or not.

## Rules for scoring end of round
When admin team sets active column of table Rounds to 2, that round will be scored. Follow these rules:

* Determine order or the teams:
  * Teams are ordered by the score achieved in this round. The score is in this round is the sum of the points value of their latest guess (wrong guesses have point value 0)
  * In case of a tie, the ties are broken by the order of the last successful guess of the teams (i.e. team with the earlier last successful guess wins)
  * If the tie persists, the order is broken by the second last guess and so on.
  * If the tie persists, the order is broken randomly
* The teams in first half (rounded up) will be awarded points by this formula:
  * The column value in table Rounds plus * 100
  * Number of teams / 2 - team rank, i.e. the first team will get (n_teams / 2 - 1) points

Insert new row for each team into the teams_per_round table with the final score for this round.

Example:

The column value in Rounds is 4, there were 5 questions. Four teams (A, B, C, D) scored 12, 10, 10 and 8 points. Team C has had last successful guess 150 seconds after the start of the round, while team B did at 180 seconds after the start of the round. The final order is therefore A, C, B, D. So in the end, A score 401 (= 4 * 100 + 4 / 2 - 1) and team C scores 400 (= 4 * 100 + 4 / 2 - 2) points. Teams B and D score 0.

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

# Quiz Master Client

Quiz master has a different client that connects to the server but uses the same server as the mobile client does. This
client is optimized for 16:9 displays (like TVs and projector) running at HD resolution. The client will receive the list
of questions from the server, information about results and display them in the following manner:

## If there's Active Round

There are two modes, 'presentation' and 'grid'. It is possible to switch between them by pressing 'P' and 'G' respectively.

### Presentation mode

The questions are first displayed in the "presentation mode". In this mode, the client displays sequence of "slides" and
user can move forward and back by pressing right arrow or space (forward) or left arrow (back). Each slide shows just
one question. If there are hints, they will be displayed too, in the same font size. The font size should be large and
try to fit the whole slide.

### Grid view

After going forward from the last slide, the master client switches into the "grid mode". In this mode the screen is divided
into a grid of two rows of three squares and a sidebar on the right. The proportion of the grid is (obviously) 13.5 : 9 and
proportion of the sidebar is the remainder, 2.5 : 9. The application should strictly maintain 16:9 overall size, even on 
devices that offer different aspect ratio.

In grid mode, top three squares and two squares on the left in the second row contain question, the remaining square (
bottom right) contains a countdown and name of the round.

Questions on the grid display latest hint text in larger font than the rest. Overall, we again try to fit the text to the
box, even if it means that different boxes have different font sizes.

The countdown shows the time remaining in the round. The server supplies information about current round, property 'length',
this is time in seconds from the start of the round to the display of the first hint. After half that time (i.e. length / 2 
seconds) the second hint is displayed and again after length / 2 seconds the round ends. The overall length of the round
is therefore 2 * length seconds.

The sidebar on the right shows the current leaderboard.

## If there's no Active Round

If the quiz haven't started yet (i.e. all rounds have active == 0), then don't display anything, but text "Game haven't 
started yet". Otherwise, the server will supply the information about the question from the last finished round and list
all guesses made by teams. We want to display the questions as follows:

* Display only the question, ignore the hints
* Show all guesses for that question, formatted in the following way:
  * If several teams submitted the same guess, group them together and add the number (e.g. 3 x right answer)
  * Colour the background of the answer depending on the score assigned to it.

Each guess has property score and property value. If score == value than this was successful guess before first hint
was displayed, it should have the best background colour. If score == value / 2, it was successful after the first but
before the second hint. Finally, score == value / 4 means it was submitted after second hint. 

# Matchmaking


# Changes from the design to be implemented

* [x] Do not return points for the current round, the team will only learn about the score from the round at the end of the round
* [x] Feed client information about all rounds, so that the teams can see how many points can be won in future
* [x] Allow pictures as questions
* [x] Unify Questions and Guess tabs
* [x] Add Help tab for Players
* [x] Better info about previous actions
* [x] Better info about situation
* [x] Store answer before normalizing (but after some cleaning)
* [x] Create 'quiz master' client
* [x] Live round results for admin in admin tab
