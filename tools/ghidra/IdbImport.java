// Pre-analysis script for a program rebuilt from an IDA database (tools/macsyms/extract_idb.py):
// the first segment is imported as a raw binary, this adds the other segments (seg_<addr>.bin),
// sets r2 to the TOC on PowerPC (second script argument, hex), creates the functions and applies
// the symbol names from <dir>/names.tsv (addr kind namespace name params const raw).
//   Mac:  analyzeHeadless <proj> MAC -import <dir>/seg_00000000.bin -loader BinaryLoader
//           -processor PowerPC:BE:32:default -scriptPath tools/ghidra
//           -preScript IdbImport.java <dir> 1889f0 -postScript DumpAll.java <outdir>
//   x86:  ... -import <dir>/seg_00401000.bin -loader BinaryLoader -loader-baseAddr 0x401000
//           -processor x86:LE:32:default -cspec windows -preScript IdbImport.java <dir>
// Analysis aid only: output feeds the specs in docs/, never the new code base.
// @category AN
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.lang.Register;
import ghidra.program.model.listing.*;
import ghidra.program.model.mem.*;
import ghidra.program.model.symbol.*;
import ghidra.app.util.NamespaceUtils;
import java.io.*;
import java.math.BigInteger;
import java.nio.file.*;
import java.util.*;

public class IdbImport extends GhidraScript {
    @Override
    public void run() throws Exception {
        String dir = getScriptArgs()[0];
        Memory mem = currentProgram.getMemory();
        AddressSpace sp = currentProgram.getAddressFactory().getDefaultAddressSpace();
        MemoryBlock first = mem.getBlocks()[0];
        long codeStart = first.getStart().getOffset();
        long codeEnd = first.getEnd().getOffset();
        first.setName("code");
        first.setExecute(true);
        boolean ppc = getScriptArgs().length > 1;
        long tocVal = ppc ? Long.parseLong(getScriptArgs()[1], 16) : 0;
        File[] segs = new File(dir).listFiles((d, n) -> n.startsWith("seg_") && n.endsWith(".bin"));
        Arrays.sort(segs);
        for (File f : segs) {
            long start = Long.parseLong(f.getName().substring(4, 12), 16);
            if (start == codeStart) continue;
            byte[] b = Files.readAllBytes(f.toPath());
            MemoryBlock blk = mem.createInitializedBlock(String.format("seg_%08x", start),
                sp.getAddress(start), new ByteArrayInputStream(b), b.length, monitor, false);
            blk.setRead(true); blk.setWrite(true); blk.setExecute(false);
        }
        if (ppc) {
            Register r2 = currentProgram.getRegister("r2");
            currentProgram.getProgramContext().setValue(r2, sp.getAddress(codeStart), sp.getAddress(codeEnd),
                BigInteger.valueOf(tocVal));
        }

        SymbolTable st = currentProgram.getSymbolTable();
        FunctionManager fm = currentProgram.getFunctionManager();
        int nf = 0, nl = 0, bad = 0;
        for (String line : Files.readAllLines(Paths.get(dir, "names.tsv"))) {
            String[] c = line.split("\t", -1);
            if (c.length < 7) continue;
            Address a = sp.getAddress(Long.parseLong(c[0], 16));
            String ns = c[2].replaceAll("\\s+", "_"), name = c[3].replaceAll("\\s+", "_");
            if (name.isEmpty()) continue;
            try {
                Namespace parent = currentProgram.getGlobalNamespace();
                if (!ns.isEmpty()) parent = NamespaceUtils.createNamespaceHierarchy(ns, null, currentProgram, SourceType.IMPORTED);
                if (c[1].equals("func") && a.getOffset() >= codeStart && a.getOffset() <= codeEnd) {
                    disassemble(a);
                    Function fn = fm.getFunctionAt(a);
                    if (fn == null) fn = createFunction(a, null);
                    if (fn == null) { bad++; continue; }
                    fn.setName(name, SourceType.IMPORTED);
                    fn.setParentNamespace(parent);
                    if (!c[4].isEmpty()) fn.setComment(c[2] + "::" + c[3] + c[4] + (c[5].equals("1") ? " const" : "") + "  [" + c[6] + "]");
                    nf++;
                } else {
                    st.createLabel(a, name, parent, SourceType.IMPORTED);
                    nl++;
                }
            } catch (Exception e) { bad++; }
        }
        println("IdbImport: functions " + nf + ", labels " + nl + ", failed " + bad);
    }
}
