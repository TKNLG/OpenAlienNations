// Apply original function names (matched from the Mac build, tools/macsyms) to a PC program.
// Input TSV: pc_ea  mac_ea  Class::method  full signature  match method
// Usage: -preScript ApplyNames.java <names.tsv>   (or -postScript before DumpAll.java)
// Analysis aid only: output feeds the specs in docs/, never the new code base.
// @category AN
import ghidra.app.script.GhidraScript;
import ghidra.app.util.NamespaceUtils;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.nio.file.*;

public class ApplyNames extends GhidraScript {
    @Override
    public void run() throws Exception {
        int ok = 0, bad = 0, cleared = 0;
        // drop names applied by an earlier run (marked by the comment), so the table is the only source
        for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
            String cm = f.getComment();
            if (cm != null && cm.startsWith("Mac name: ")) {
                f.setComment(null);
                f.setParentNamespace(currentProgram.getGlobalNamespace());
                f.setName(null, SourceType.DEFAULT);
                cleared++;
            }
        }
        for (String line : Files.readAllLines(Paths.get(getScriptArgs()[0]))) {
            String[] c = line.split("\t", -1);
            if (c.length < 5) continue;
            Function f = getFunctionAt(toAddr(Long.parseLong(c[0], 16)));
            if (f == null) { bad++; continue; }
            String full = c[2];
            int k = full.lastIndexOf("::");
            String ns = k > 0 ? full.substring(0, k) : "";
            String name = (k > 0 ? full.substring(k + 2) : full).replaceAll("\\s+", "_");
            try {
                Namespace parent = currentProgram.getGlobalNamespace();
                if (!ns.isEmpty()) parent = NamespaceUtils.createNamespaceHierarchy(ns.replaceAll("\\s+", "_"), null, currentProgram, SourceType.IMPORTED);
                f.setName(name, SourceType.IMPORTED);
                f.setParentNamespace(parent);
                f.setComment("Mac name: " + c[3] + "  (Mac " + c[1] + ", matched by " + c[4] + ")");
                ok++;
            } catch (Exception e) { bad++; }
        }
        println("ApplyNames: cleared " + cleared + ", named " + ok + ", failed " + bad);
    }
}
