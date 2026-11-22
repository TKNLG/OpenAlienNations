// Pre-analysis script: create functions at the addresses listed in a text file (one hex address
// per line), e.g. virtual methods only reachable through vtables (tools/macsyms/vtables.py),
// which auto-analysis does not find. Usage: -preScript CreateFunctions.java <file>
// Analysis aid only: output feeds the specs in docs/, never the new code base.
// @category AN
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import java.nio.file.*;

public class CreateFunctions extends GhidraScript {
    @Override
    public void run() throws Exception {
        int made = 0, had = 0, bad = 0;
        for (String l : Files.readAllLines(Paths.get(getScriptArgs()[0]))) {
            l = l.trim();
            if (l.isEmpty()) continue;
            Address a = toAddr(Long.parseLong(l, 16));
            if (getFunctionAt(a) != null) { had++; continue; }
            Function inside = getFunctionContaining(a);
            if (inside != null) {
                // a vtable target inside another function body means that body ran into it
                inside.setBody(new ghidra.program.model.address.AddressSet(inside.getEntryPoint(), a.subtract(1)));
            }
            disassemble(a);
            if (createFunction(a, null) != null) made++; else bad++;
        }
        println("CreateFunctions: created " + made + ", existing " + had + ", failed " + bad);
    }
}
