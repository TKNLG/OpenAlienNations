// Dump every function's decompiled pseudocode, plus all defined strings with their
// referencing functions, into text files for offline searching.
// Analysis aid only: output feeds the specs in docs/, never the new code base.
// @category AN
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.address.*;
import ghidra.program.model.data.StringDataInstance;
import java.io.*;

public class DumpAll extends GhidraScript {
    @Override
    public void run() throws Exception {
        String outDir = getScriptArgs().length > 0 ? getScriptArgs()[0] : ".";
        DecompInterface di = new DecompInterface();
        di.openProgram(currentProgram);
        Listing listing = currentProgram.getListing();
        FunctionManager fm = currentProgram.getFunctionManager();

        try (PrintWriter pw = new PrintWriter(new FileWriter(outDir + "/decomp.c"))) {
            int n = 0;
            for (Function f : fm.getFunctions(true)) {
                if (monitor.isCancelled()) break;
                DecompileResults r = di.decompileFunction(f, 60, monitor);
                pw.println("// ===== " + f.getEntryPoint() + " " + f.getName() + " =====");
                if (r != null && r.decompileCompleted()) pw.println(r.getDecompiledFunction().getC());
                else pw.println("// decompile failed");
                n++;
            }
            println("functions: " + n);
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(outDir + "/strings.txt"))) {
            ReferenceManager rm = currentProgram.getReferenceManager();
            for (Data d : listing.getDefinedData(true)) {
                StringDataInstance s = StringDataInstance.getStringDataInstance(d);
                if (s == StringDataInstance.NULL_INSTANCE) continue;
                String val = s.getStringValue();
                if (val == null) continue;
                StringBuilder refs = new StringBuilder();
                for (Reference ref : rm.getReferencesTo(d.getAddress())) {
                    Function f = fm.getFunctionContaining(ref.getFromAddress());
                    refs.append(' ').append(ref.getFromAddress())
                        .append(f != null ? "(" + f.getName() + ")" : "");
                }
                pw.println(d.getAddress() + "\t" + val.replace("\n", "\\n").replace("\r", "\\r") + "\t" + refs);
            }
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(outDir + "/imports.txt"))) {
            ReferenceManager rm = currentProgram.getReferenceManager();
            for (Symbol s : currentProgram.getSymbolTable().getExternalSymbols()) {
                StringBuilder refs = new StringBuilder();
                for (Reference ref : rm.getReferencesTo(s.getAddress())) {
                    Function f = fm.getFunctionContaining(ref.getFromAddress());
                    if (f != null) refs.append(' ').append(f.getName());
                }
                pw.println(s.getParentNamespace().getName() + "!" + s.getName() + "\t" + refs);
            }
        }
    }
}
