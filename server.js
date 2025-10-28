// server.js
// Simple express backend that judges JS / Python / C++ / Java via Docker

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");

const app = express();
app.use(express.json({ limit: "500kb" }));
app.use(express.static(path.join(__dirname, "public"))); // serves index.html etc

/****************************************************************
 * 1. Reference solutions in JS (used to compute "expected")
 ****************************************************************/

// Deep clone helper
function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// Greedy knapsack heuristic
function referenceGreedyKnapsack(items, capacity) {
    const arr = deepClone(items).sort(
        (a,b) => (b.value/b.weight) - (a.value/a.weight)
    );
    let totalVal = 0;
    let remaining = capacity;
    for (const it of arr) {
        if (it.weight <= remaining) {
            totalVal += it.value;
            remaining -= it.weight;
        }
    }
    return totalVal;
}

// Optimal DP knapsack
function referenceDpKnapsack(items, capacity) {
    const dp = new Array(capacity+1).fill(0);
    for (const it of items) {
        for (let w=capacity; w>=it.weight; w--) {
            dp[w] = Math.max(dp[w], dp[w-it.weight] + it.value);
        }
    }
    return dp[capacity];
}

// Activity Selection
function referenceActivitySelection(intervals) {
    const arr = deepClone(intervals).sort((a,b)=>a.end-b.end);
    let count = 0;
    let lastEnd = -Infinity;
    for (const iv of arr) {
        if (iv.start >= lastEnd) {
            count++;
            lastEnd = iv.end;
        }
    }
    return count;
}

// Coin Change
function referenceCoinChange(coins, amount) {
    const INF = 1e9;
    const dp = new Array(amount+1).fill(INF);
    dp[0] = 0;
    for (let a=1; a<=amount; a++) {
        for (const c of coins) {
            if (c <= a) {
                dp[a] = Math.min(dp[a], dp[a-c] + 1);
            }
        }
    }
    return dp[amount] >= INF ? -1 : dp[amount];
}

/****************************************************************
 * 2. Canonical tests for each problem
 ****************************************************************/

const TESTS = {
    greedy_knapsack: [
        {
            input: [
                [
                    {weight:10,value:60},
                    {weight:20,value:100},
                    {weight:30,value:120},
                ],
                50
            ]
        },
        {
            input: [
                [
                    {weight:6,value:25},
                    {weight:5,value:24},
                    {weight:4,value:15},
                    {weight:2,value:7},
                ],
                10
            ]
        }
    ],

    activity_selection: [
        {
            input: [[
                {start:1,end:3},
                {start:2,end:5},
                {start:4,end:7},
                {start:1,end:8},
                {start:5,end:9},
                {start:8,end:10},
            ]]
        },
        {
            input: [[
                {start:0,end:2},
                {start:1,end:3},
                {start:3,end:4},
                {start:2,end:5},
                {start:5,end:6},
            ]]
        }
    ],

    dp_knapsack: [
        {
            input: [
                [
                    {weight:10,value:60},
                    {weight:20,value:100},
                    {weight:30,value:120},
                ],
                50
            ]
        },
        {
            input: [
                [
                    {weight:6,value:25},
                    {weight:5,value:24},
                    {weight:4,value:15},
                    {weight:2,value:7},
                ],
                10
            ]
        }
    ],

    coin_change: [
        { input: [[1,2,5], 11] },
        { input: [[2], 3] },
        { input: [[2,4,6], 8] },
    ],
};

// Mapping: problemId -> expectedOutputs fn
function computeExpected(problemId) {
    const tests = TESTS[problemId];
    if (!tests) return null;
    const expected = [];
    for (const tc of tests) {
        const args = deepClone(tc.input);
        switch (problemId) {
            case "greedy_knapsack":
                expected.push(referenceGreedyKnapsack(args[0], args[1]));
                break;
            case "dp_knapsack":
                expected.push(referenceDpKnapsack(args[0], args[1]));
                break;
            case "activity_selection":
                expected.push(referenceActivitySelection(args[0]));
                break;
            case "coin_change":
                expected.push(referenceCoinChange(args[0], args[1]));
                break;
            default:
                expected.push(null);
        }
    }
    return expected;
}

// Mapping: problemId -> which function name user must provide
const ENTRY_FN = {
    greedy_knapsack: "solveKnapsackGreedy",
    dp_knapsack: "solveKnapsackOptimal",
    activity_selection: "solveActivitySelection",
    coin_change: "solveCoinChange",
};

/****************************************************************
 * 3. Harness generators
 * We'll generate a tmp file that:
 *   - calls the user's function on all TESTS[problemId]
 *   - prints JSON array of results to stdout
 *
 * JS + Python harnesses are generic (use TESTS as JSON).
 * C++ / Java harnesses are problem-specific, because of typing.
 ****************************************************************/

function genHarnessJS(problemId) {
    const testsJSON = JSON.stringify(TESTS[problemId]);
    const fn = ENTRY_FN[problemId];
    return `
const TESTS = ${testsJSON};
(function(){
    const results = [];
    for (const tc of TESTS) {
        try {
            results.push(${fn}(...tc.input));
        } catch (err) {
            results.push("__ERROR__:"+err.toString());
        }
    }
    console.log(JSON.stringify(results));
})();`;
}

function genHarnessPy(problemId) {
    const testsJSON = JSON.stringify(TESTS[problemId]);
    const fn = ENTRY_FN[problemId];
    return `
import json
TESTS = json.loads(r'''${testsJSON}''')

def _run_tests():
    results = []
    for tc in TESTS:
        args = tc["input"]
        try:
            results.append(${fn}(*args))
        except Exception as e:
            results.append("__ERROR__:"+str(e))
    print(json.dumps(results))

_run_tests()
`;
}

/************ C++ harness ************/
function genHarnessCpp(problemId) {
    const fn = ENTRY_FN[problemId];
    let bodyBlocks = [];

    if (problemId === "greedy_knapsack" || problemId === "dp_knapsack") {
        for (const tc of TESTS[problemId]) {
            const items = tc.input[0];
            const cap = tc.input[1];
            let block = `{\n    vector<Item> items;\n`;
            for (const it of items) {
                block += `    items.push_back({${it.weight},${it.value}});\n`;
            }
            block += `    int capacity = ${cap};\n`;
            block += `    results.push_back(${fn}(items, capacity));\n}\n`;
            bodyBlocks.push(block);
        }
    } else if (problemId === "activity_selection") {
        for (const tc of TESTS[problemId]) {
            const intervals = tc.input[0];
            let block = `{\n    vector<Interval> intervals;\n`;
            for (const iv of intervals) {
                block += `    intervals.push_back({${iv.start},${iv.end}});\n`;
            }
            block += `    results.push_back(${fn}(intervals));\n}\n`;
            bodyBlocks.push(block);
        }
    } else if (problemId === "coin_change") {
        for (const tc of TESTS[problemId]) {
            const coins = tc.input[0];
            const amt = tc.input[1];
            let block = `{\n    vector<int> coins = {${coins.join(",")}};\n`;
            block += `    int amount = ${amt};\n`;
            block += `    results.push_back(${fn}(coins, amount));\n}\n`;
            bodyBlocks.push(block);
        }
    }

    return `
#include <iostream>
#include <vector>
#include <string>
using namespace std;

int main(){
    vector<int> results;
${bodyBlocks.map(b => "    " + b.replace(/\n/g,"\n    ")).join("\n")}
    cout << "[";
    for (size_t i=0;i<results.size();++i){
        if(i) cout << ",";
        cout << results[i];
    }
    cout << "]";
    return 0;
}
`;
}

/************ Java harness ************/
function genHarnessJava(problemId) {
    const fn = ENTRY_FN[problemId];
    let bodyBlocks = [];

    if (problemId === "greedy_knapsack" || problemId === "dp_knapsack") {
        for (const tc of TESTS[problemId]) {
            const items = tc.input[0];
            const cap = tc.input[1];
            let block = `{\n        ArrayList<Item> items = new ArrayList<>();\n`;
            for (const it of items) {
                block += `        items.add(new Item(${it.weight}, ${it.value}));\n`;
            }
            block += `        int capacity = ${cap};\n`;
            block += `        results.add(Solution.${fn}(items, capacity));\n    }\n`;
            bodyBlocks.push(block);
        }
    } else if (problemId === "activity_selection") {
        for (const tc of TESTS[problemId]) {
            const intervals = tc.input[0];
            let block = `{\n        ArrayList<Interval> intervals = new ArrayList<>();\n`;
            for (const iv of intervals) {
                block += `        intervals.add(new Interval(${iv.start}, ${iv.end}));\n`;
            }
            block += `        results.add(Solution.${fn}(intervals));\n    }\n`;
            bodyBlocks.push(block);
        }
    } else if (problemId === "coin_change") {
        for (const tc of TESTS[problemId]) {
            const coins = tc.input[0];
            const amt = tc.input[1];
            let block = `{\n        int[] coins = new int[]{${coins.join(",")}};\n`;
            block += `        int amount = ${amt};\n`;
            block += `        results.add(Solution.${fn}(coins, amount));\n    }\n`;
            bodyBlocks.push(block);
        }
    }

    return `
import java.util.*;

public class Main {
    public static void main(String[] args){
        ArrayList<Integer> results = new ArrayList<>();
${bodyBlocks.map(b => "        " + b.replace(/\n/g,"\n        ")).join("\n")}
        System.out.print("[");
        for (int i=0;i<results.size();i++){
            if(i>0) System.out.print(",");
            System.out.print(results.get(i));
        }
        System.out.print("]");
    }
}
`;
}

/****************************************************************
 * 4. Actually run code in Docker
 ****************************************************************/

const DOCKER_IMAGE = "algorunner-all"; // you'll build this image from the Dockerfile below

function runInDocker(lang, tmpDir) {
    // pick command to run
    let cmd;
    if (lang === "js") {
        cmd = `bash -c "node /work/main.js"`;
    } else if (lang === "py") {
        cmd = `bash -c "python3 /work/main.py"`;
    } else if (lang === "cpp") {
        cmd = `bash -c "g++ /work/main.cpp -std=c++17 -O2 -o /work/a.out && /work/a.out"`;
    } else if (lang === "java") {
        cmd = `bash -c "javac /work/Solution.java /work/Main.java && java -cp /work Main"`;
    } else {
        throw new Error("unsupported lang");
    }

    const full = `docker run --rm -v ${tmpDir}:/work ${DOCKER_IMAGE} ${cmd}`;
    try {
        const out = execSync(full, { timeout: 2000 }); // ms
        return { ok: true, stdout: out.toString() };
    } catch (err) {
        const stdout = err.stdout ? err.stdout.toString() : "";
        const stderr = err.stderr ? err.stderr.toString() : "";
        return {
            ok: false,
            stdout,
            stderr,
            message: err.message
        };
    }
}

/****************************************************************
 * 5. /run endpoint
 ****************************************************************/
app.post("/run", (req,res)=>{
    const { lang, problemId, code } = req.body || {};

    if (!lang || !problemId || typeof code !== "string") {
        return res.json({ error: "Missing lang/problemId/code" });
    }
    if (!ENTRY_FN[problemId]) {
        return res.json({ error: "Unknown problemId" });
    }
    if (!["js","py","cpp","java"].includes(lang)) {
        return res.json({ error: "Unsupported language" });
    }

    // build expected results
    const expected = computeExpected(problemId);
    if (!expected) {
        return res.json({ error:"No tests for that problem or internal config error."});
    }

    // make temp dir
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-") + crypto.randomBytes(4).toString("hex"));

    // write user code + harness(es)
    if (lang === "js") {
        const mainJS = code + "\n" + genHarnessJS(problemId);
        fs.writeFileSync(path.join(tmpDir, "main.js"), mainJS);
    } else if (lang === "py") {
        const mainPy = code + "\n" + genHarnessPy(problemId);
        fs.writeFileSync(path.join(tmpDir, "main.py"), mainPy);
    } else if (lang === "cpp") {
        const mainCpp = code + "\n" + genHarnessCpp(problemId);
        fs.writeFileSync(path.join(tmpDir, "main.cpp"), mainCpp);
    } else if (lang === "java") {
        // Java needs two files: user's Solution.java and harness Main.java
        fs.writeFileSync(path.join(tmpDir, "Solution.java"), code);
        fs.writeFileSync(path.join(tmpDir, "Main.java"), genHarnessJava(problemId));
    }

    // run in docker
    const result = runInDocker(lang, tmpDir);
    if (!result.ok) {
        return res.json({
            error: "Compilation/runtime error",
            details: result.message,
            stdout: result.stdout,
            stderr: result.stderr
        });
    }

    // parse user outputs
    let userOutputs;
    try {
        userOutputs = JSON.parse(result.stdout.trim());
    } catch (e) {
        return res.json({
            error: "Could not parse runner output",
            raw: result.stdout
        });
    }

    // compare vs expected
    const perTest = [];
    let allPassed = true;
    for (let i=0; i<expected.length; i++) {
        const want = expected[i];
        const got  = userOutputs[i];
        if (typeof got === "string" && got.startsWith("__ERROR__")) {
            allPassed = false;
            perTest.push({
                expected: want,
                got: null,
                passed: false,
                error: got
            });
        } else {
            const passed = (JSON.stringify(want) === JSON.stringify(got));
            if (!passed) allPassed = false;
            perTest.push({
                expected: want,
                got,
                passed,
                error: null
            });
        }
    }

    res.json({
        results: perTest,
        allPassed,
        message: allPassed
            ? "All tests passed. 🎉"
            : "Some tests failed. Keep iterating."
    });
});

/****************************************************************
 * 6. Listen
 ****************************************************************/
const PORT = 3000;
app.listen(PORT, ()=>{
    console.log(`Algo Arena judge listening on http://localhost:${PORT}`);
});
