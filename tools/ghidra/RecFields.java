// List every access to a field of a dv.odb record (0x18C bytes) found by local data flow.
// A varnode counts as a record pointer when it is
//   (a) loaded from [x + 0xC]           ("obj"   - every game object keeps its record at +0xC;
//                                         this also catches unrelated structs, so check by hand)
//   (b) loaded through the global record table at 0x4B3900 ("table")
// and record pointers are followed through COPY/CAST/INDIRECT/MULTIEQUAL.
// Output: func  opaddr  offset  mode(load/store/addr/idx)  source
// Analysis aid only: output feeds the specs in docs/, never the new code base.
// @category AN
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.pcode.*;
import ghidra.program.model.address.*;
import java.io.*;
import java.util.*;

public class RecFields extends GhidraScript {
    static final long TABLE = 0x4b3900L;
    Map<Varnode, String> memo = new HashMap<>();
    Set<Varnode> visiting = new HashSet<>();
    Map<String, Set<Integer>> recParams = new HashMap<>();
    Set<Integer> curParams = null;

    // returns [base, const] if v = base + const (const may be 0)
    Object[] split(Varnode v) {
        PcodeOp d = v.getDef();
        if (d != null) {
            int oc = d.getOpcode();
            if ((oc == PcodeOp.INT_ADD || oc == PcodeOp.PTRSUB) && d.getInput(1).isConstant())
                return new Object[]{d.getInput(0), d.getInput(1).getOffset()};
            if (oc == PcodeOp.INT_ADD && d.getInput(0).isConstant())
                return new Object[]{d.getInput(1), d.getInput(0).getOffset()};
            if (oc == PcodeOp.CAST || oc == PcodeOp.COPY) return split(d.getInput(0));
        }
        return new Object[]{v, 0L};
    }

    boolean containsTable(Varnode v, int depth) {
        if (v == null || depth > 10) return false;
        if (v.isAddress() && v.getAddress().getOffset() == TABLE) return true;
        if (v.isConstant() && v.getOffset() == TABLE) return true;
        PcodeOp d = v.getDef();
        if (d == null) return false;
        for (int i = 0; i < d.getNumInputs(); i++) {
            if (d.getOpcode() == PcodeOp.LOAD && i == 0) continue;
            if (containsTable(d.getInput(i), depth + 1)) return true;
        }
        return false;
    }

    // count LOAD levels from v down to the table global
    int tableLoads(Varnode v, int depth) {
        if (v == null || depth > 14) return -1;
        if (v.isAddress() && v.getAddress().getOffset() == TABLE) return 0;
        PcodeOp d = v.getDef();
        if (d == null) return -1;
        int best = -1;
        for (int i = 0; i < d.getNumInputs(); i++) {
            if (d.getOpcode() == PcodeOp.LOAD && i == 0) continue;
            int r = tableLoads(d.getInput(i), depth + 1);
            if (r >= 0) {
                int rr = r + (d.getOpcode() == PcodeOp.LOAD ? 1 : 0);
                if (best < 0 || rr < best) best = rr;
            }
        }
        return best;
    }

    String recSrc(Varnode v) {
        if (v == null) return null;
        if (memo.containsKey(v)) return memo.get(v);
        if (visiting.contains(v)) return null;
        visiting.add(v);
        String res = null;
        PcodeOp d = v.getDef();
        if (d == null && curParams != null) {
            HighVariable hv = v.getHigh();
            if (hv instanceof HighParam && curParams.contains(((HighParam) hv).getSlot())) res = "param";
        }
        if (d != null) {
            int oc = d.getOpcode();
            if (oc == PcodeOp.LOAD) {
                Varnode a = d.getInput(1);
                int tl = tableLoads(v, 0);
                if (tl == 2) res = "table";
                else {
                    Object[] s = split(a);
                    if ((Long) s[1] == 0xcL) res = "obj";
                }
            } else if (oc == PcodeOp.COPY || oc == PcodeOp.CAST || oc == PcodeOp.INDIRECT) {
                res = recSrc(d.getInput(0));
            } else if (oc == PcodeOp.MULTIEQUAL) {
                for (int i = 0; i < d.getNumInputs() && res == null; i++) res = recSrc(d.getInput(i));
            }
        }
        visiting.remove(v);
        memo.put(v, res);
        return res;
    }

    @Override
    public void run() throws Exception {
        String out = getScriptArgs()[0];
        if (getScriptArgs().length > 1) {
            try (BufferedReader br = new BufferedReader(new FileReader(getScriptArgs()[1]))) {
                String l;
                while ((l = br.readLine()) != null) {
                    String[] p = l.trim().split("\\s+");
                    if (p.length < 2) continue;
                    recParams.computeIfAbsent(p[0], k -> new HashSet<>()).add(Integer.parseInt(p[1]));
                }
            }
        }
        DecompInterface di = new DecompInterface();
        di.openProgram(currentProgram);
        FunctionManager fm = currentProgram.getFunctionManager();
        try (PrintWriter pw = new PrintWriter(new FileWriter(out))) {
            for (Function f : fm.getFunctions(true)) {
                if (monitor.isCancelled()) break;
                DecompileResults r = di.decompileFunction(f, 60, monitor);
                if (r == null || !r.decompileCompleted()) continue;
                HighFunction hf = r.getHighFunction();
                if (hf == null) continue;
                memo.clear();
                curParams = recParams.get(f.getEntryPoint().toString());
                Iterator<PcodeOpAST> it = hf.getPcodeOps();
                Set<String> seen = new HashSet<>();
                while (it.hasNext()) {
                    PcodeOpAST op = it.next();
                    int oc = op.getOpcode();
                    String mode = null; Varnode addr = null;
                    if (oc == PcodeOp.CALL) {
                        for (int i = 1; i < op.getNumInputs(); i++) {
                            String src = recSrc(op.getInput(i));
                            if (src != null) {
                                String line = f.getEntryPoint() + "\t" + op.getSeqnum().getTarget() + "\tCALL\t" +
                                    String.format("%08x", op.getInput(0).getAddress().getOffset()) + "\t" + (i - 1) + "\t" + src;
                                if (seen.add(line)) pw.println(line);
                            }
                        }
                        continue;
                    }
                    if (oc == PcodeOp.STORE) {
                        String src = recSrc(op.getInput(2));
                        if (src != null) {
                            Object[] s = split(op.getInput(1));
                            String line = f.getEntryPoint() + "\t" + op.getSeqnum().getTarget() + "\tHOLD\t" +
                                String.format("%x", (Long) s[1]) + "\t" + src;
                            if (seen.add(line)) pw.println(line);
                        }
                    }
                    if (oc == PcodeOp.LOAD) { mode = "load"; addr = op.getInput(1); }
                    else if (oc == PcodeOp.STORE) { mode = "store"; addr = op.getInput(1); }
                    else if ((oc == PcodeOp.INT_ADD || oc == PcodeOp.PTRSUB) && op.getInput(1).isConstant()) {
                        // address-of: only report if not consumed directly by LOAD/STORE
                        boolean direct = true;
                        Iterator<PcodeOp> ds = op.getOutput().getDescendants();
                        while (ds.hasNext()) {
                            PcodeOp u = ds.next();
                            int uo = u.getOpcode();
                            if (!((uo == PcodeOp.LOAD || uo == PcodeOp.STORE) && u.getInput(1) == op.getOutput())) direct = false;
                        }
                        if (direct) continue;
                        mode = "addr"; addr = op.getOutput();
                    } else if (oc == PcodeOp.PTRADD) {
                        mode = "idx"; addr = op.getOutput();
                    }
                    if (addr == null) continue;
                    long off; Varnode base;
                    if (mode.equals("idx")) {
                        base = op.getInput(0); off = 0;
                        Object[] s = split(base);
                        base = (Varnode) s[0]; off = (Long) s[1];
                    } else {
                        Object[] s = split(addr);
                        base = (Varnode) s[0]; off = (Long) s[1];
                    }
                    if (off < 0 || off >= 0x18c) continue;
                    String src = recSrc(base);
                    if (src == null) continue;
                    String line = f.getEntryPoint() + "\t" + op.getSeqnum().getTarget() + "\t" +
                        String.format("%03x", off) + "\t" + mode + "\t" + src;
                    if (seen.add(line)) pw.println(line);
                }
            }
        }
    }
}
