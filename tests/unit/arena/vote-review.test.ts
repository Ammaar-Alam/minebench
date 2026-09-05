import assert from "node:assert/strict";
import { voteReviewFlags } from "../../../lib/arena/voteReview";

const ordinary = { votes: 30, choiceA: 14, choiceB: 14, bothBad: 2, fastVotes: 0, repeatVotes: 2, rankedVotes: 28, upsets: 8, largeUpsets: 1 };
assert.deepEqual(voteReviewFlags(ordinary), []);
assert.deepEqual(voteReviewFlags({ ...ordinary, fastVotes: 15 }), ["Rapid voting"]);
assert.deepEqual(voteReviewFlags({ ...ordinary, choiceA: 26, choiceB: 2 }), ["One-sided voting"]);
assert.deepEqual(voteReviewFlags({ ...ordinary, upsets: 23 }), ["Repeated ranking upsets"]);
assert.deepEqual(voteReviewFlags({ ...ordinary, largeUpsets: 3 }), ["Large ranking upsets"]);
assert.deepEqual(voteReviewFlags({ ...ordinary, repeatVotes: 15 }), ["Repeated matchups"]);
assert.deepEqual(voteReviewFlags({ votes: 3, choiceA: 0, choiceB: 3, bothBad: 0, fastVotes: 2, repeatVotes: 2, rankedVotes: 3, upsets: 3, largeUpsets: 3 }), []);
assert.deepEqual(voteReviewFlags({ votes: 21, choiceA: 6, choiceB: 5, bothBad: 10, fastVotes: 0, repeatVotes: 2, rankedVotes: 11, upsets: 10, largeUpsets: 4 }), ["Repeated ranking upsets", "Large ranking upsets", "Frequent rejections"]);
assert.deepEqual(voteReviewFlags({ ...ordinary, rankedVotes: 0, upsets: 0, largeUpsets: 0 }), []);
console.log("vote review signal checks passed");
