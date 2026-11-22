// Per-function features for cross-build function matching (tools/macsyms/match.py):
// one JSON object per line with entry, size, instruction count, ordered callees (call sites in
// address order; external calls by name), referenced strings (following one pointer level, for
// the PowerPC TOC) and scalar constants / field offsets.
// Analysis aid only: output feeds the specs in docs/, never the new code base.
// @category AN
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.mem.*;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.util.*;

public class FeatureDump extends GhidraScript {
    Memory mem;

    String cstr(Address a) {
        try {
            if (a == null || !mem.contains(a)) return null;
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 200; i++) {
                byte b = mem.getByte(a.add(i));
                if (b == 0) break;
                int c = b & 0xff;
                if (c < 0x20 && c != 9 && c != 10 && c != 13) return null;
                if (c > 0x7e && c < 0xa0) return null;
                sb.append((char) c);
            }
            return sb.length() >= 4 ? sb.toString() : null;
        } catch (Exception e) { return null; }
    }

    Address ptrAt(Address a) {
        try {
            int v = mem.getInt(a);
            return a.getAddressSpace().getAddress(v & 0xffffffffL);
        } catch (Exception e) { return null; }
    }

    static String js(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20 || c > 0x7e) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

    // PowerPC: resolve TOC pool loads (lwz rD,d(r2) then addi rD,rD,imm) to string addresses.
    void trackPpc(Instruction ins, Map<String, Long> regs, long toc, List<String> strs) {
        String m = ins.getMnemonicString();
        Object[] o0 = ins.getNumOperands() > 0 ? ins.getOpObjects(0) : new Object[0];
        String rd = (o0.length == 1 && o0[0] instanceof ghidra.program.model.lang.Register) ? o0[0].toString() : null;
        Long val = null;
        try {
            if (m.equals("lwz") && ins.getNumOperands() == 2) {
                Object[] o1 = ins.getOpObjects(1);
                if (o1.length == 2 && o1[1].toString().equals("r2") && o1[0] instanceof Scalar) {
                    Address slot = currentProgram.getAddressFactory().getDefaultAddressSpace()
                        .getAddress(toc + ((Scalar) o1[0]).getSignedValue());
                    val = mem.getInt(slot) & 0xffffffffL;
                }
            } else if ((m.equals("addi") || m.equals("subi")) && ins.getNumOperands() == 3) {
                String ra = ins.getOpObjects(1)[0].toString();
                Object[] o2 = ins.getOpObjects(2);
                if (regs.containsKey(ra) && o2.length == 1 && o2[0] instanceof Scalar) {
                    long imm = ((Scalar) o2[0]).getSignedValue();
                    val = regs.get(ra) + (m.equals("subi") ? -imm : imm);
                }
            }
        } catch (Exception e) { val = null; }
        if (rd != null) {
            if (val != null) {
                regs.put(rd, val);
                String s = cstr(currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(val));
                if (s != null && m.startsWith("add")) strs.add(s);
                else if (s != null && m.equals("lwz")) strs.add(s);
            } else regs.remove(rd);
        }
        if (ins.getFlowType().isCall()) { regs.keySet().removeIf(k -> !k.equals("r2")); }
    }

    @Override
    public void run() throws Exception {
        String out = getScriptArgs()[0];
        mem = currentProgram.getMemory();
        Listing listing = currentProgram.getListing();
        FunctionManager fm = currentProgram.getFunctionManager();
        try (PrintWriter pw = new PrintWriter(new FileWriter(out))) {
            for (Function f : fm.getFunctions(true)) {
                if (monitor.isCancelled()) break;
                List<String> calls = new ArrayList<>();
                List<String> strs = new ArrayList<>();
                List<Long> consts = new ArrayList<>();
                int ni = 0;
                boolean ppc = currentProgram.getLanguage().getProcessor().toString().startsWith("PowerPC");
                Map<String, Long> regs = new HashMap<>();
                long toc = 0x1889f0L;
                StringBuilder mn = new StringBuilder(), norm = new StringBuilder();
                for (Instruction ins : listing.getInstructions(f.getBody(), true)) {
                    ni++;
                    mn.append(ins.getMnemonicString()).append(' ');
                    norm.append(ins.getMnemonicString());
                    for (int i = 0; i < ins.getNumOperands(); i++) {
                        norm.append(i == 0 ? ' ' : ',');
                        for (Object o : ins.getOpObjects(i)) {
                            if (o instanceof Scalar) {
                                long v = ((Scalar) o).getUnsignedValue();
                                norm.append(v >= 0x400000L && v < 0x600000L ? "A" : Long.toHexString(v));
                            } else if (o instanceof Address) norm.append("A");
                            else norm.append(o);
                            norm.append(' ');
                        }
                    }
                    norm.append(';');
                    if (ppc) trackPpc(ins, regs, toc, strs);
                    for (Reference r : ins.getReferencesFrom()) {
                        RefType t = r.getReferenceType();
                        Address to = r.getToAddress();
                        if (t.isCall()) {
                            Function cf = fm.getFunctionAt(to);
                            if (cf != null && cf.isThunk()) {
                                Function tf = cf.getThunkedFunction(true);
                                if (tf != null && tf.isExternal()) { calls.add("ext:" + tf.getName()); continue; }
                            }
                            if (r.isExternalReference() || to.isExternalAddress()) {
                                Symbol s = currentProgram.getSymbolTable().getPrimarySymbol(to);
                                calls.add("ext:" + (s != null ? s.getName() : "?"));
                            } else calls.add(String.format("%08x", to.getOffset()));
                        } else if (t.isData() || t.isRead()) {
                            if (to.isExternalAddress()) {
                                Symbol s = currentProgram.getSymbolTable().getPrimarySymbol(to);
                                if (s != null) calls.add("ext:" + s.getName());
                                continue;
                            }
                            String s = cstr(to);
                            if (s == null) s = cstr(ptrAt(to));
                            if (s != null) strs.add(s);
                            else {
                                // indirect call through an import table slot (x86 call [IAT])
                                Symbol is = currentProgram.getSymbolTable().getPrimarySymbol(to);
                                MemoryBlock ib = mem.getBlock(to);
                                if (ins.getFlowType().isCall() && is != null && is.getSource() != SourceType.DEFAULT
                                        && ib != null && !ib.isExecute()) {
                                    calls.add("ext:" + is.getName().replaceFirst("^__imp_", ""));
                                    continue;
                                }
                                Data d = listing.getDataAt(to);
                                if (d != null && d.isPointer()) {
                                    Object v = d.getValue();
                                    if (v instanceof Address && ((Address) v).isExternalAddress()) {
                                        Symbol es = currentProgram.getSymbolTable().getPrimarySymbol((Address) v);
                                        if (es != null && ins.getFlowType().isCall()) calls.add("ext:" + es.getName());
                                    }
                                }
                            }
                        }
                    }
                    for (int i = 0; i < ins.getNumOperands(); i++) {
                        for (Object o : ins.getOpObjects(i)) {
                            if (o instanceof Scalar) {
                                long v = ((Scalar) o).getSignedValue();
                                if (v >= 0x10 && v < 0x100000) consts.add(v);
                                else if (v <= -0x10 && v > -0x100000) consts.add(v);
                            }
                        }
                    }
                }
                StringBuilder sb = new StringBuilder();
                sb.append("{\"ea\":\"").append(String.format("%08x", f.getEntryPoint().getOffset())).append("\"");
                sb.append(",\"name\":").append(js(f.getName(true)));
                sb.append(",\"size\":").append(f.getBody().getNumAddresses());
                sb.append(",\"ni\":").append(ni);
                sb.append(",\"thunk\":").append(f.isThunk());
                sb.append(",\"mn\":").append(js(mn.toString().trim()));
                sb.append(",\"sh\":\"").append(Integer.toHexString(norm.toString().hashCode()))
                  .append(Integer.toHexString(norm.reverse().toString().hashCode())).append("\"");
                sb.append(",\"calls\":[");
                for (int i = 0; i < calls.size(); i++) sb.append(i > 0 ? "," : "").append(js(calls.get(i)));
                sb.append("],\"strs\":[");
                for (int i = 0; i < strs.size(); i++) sb.append(i > 0 ? "," : "").append(js(strs.get(i)));
                sb.append("],\"consts\":[");
                for (int i = 0; i < consts.size(); i++) sb.append(i > 0 ? "," : "").append(consts.get(i));
                sb.append("]}");
                pw.println(sb);
            }
        }
        println("FeatureDump: done");
    }
}
